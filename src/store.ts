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
export type ResponseKind = 'answer' | 'clarify' | 'decline'
export type ActionOwner = 'decision' | 'task' | 'approval'

// A proposed human response attached to a question item or decision-shaped
// blocked row; detail carries the tradeoff shown beside the choice.
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
  next_step: string
  action_owner: ActionOwner | null
  impact: string
  next_after: string
  context: string
  status: Status
  annotation: string | null
  options: QuestionOption[] | null
  reply: string | null
  reply_context: string | null
  replied_at: string | null
  reply_seen_at: string | null
  reply_source: ReplySource | null
  reply_kind: ResponseKind | null
  snoozed_until: string | null
  outcome: string
  outcome_at: string | null
  // issue #30 — the source-link identity inferred locally at write time:
  // `owner/name` for a github.com remote, and the issue number the BRANCH names.
  // Both null whenever the answer was not unambiguous, and null on every row
  // written before #30 (the additive migration backfills nothing — deliberately;
  // there is no way to know what a historical item's remote was).
  repo: string | null
  issue_ref: number | null
  created_at: string
  updated_at: string
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
  next_step?: string
  action_owner?: ActionOwner | null
  impact?: string
  next_after?: string
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
      next_step TEXT NOT NULL DEFAULT '',
      action_owner TEXT,
      impact TEXT NOT NULL DEFAULT '',
      next_after TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      annotation TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      reply_kind TEXT,
      snoozed_until TEXT,
      outcome TEXT NOT NULL DEFAULT '',
      outcome_at TEXT,
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
      revision INTEGER NOT NULL DEFAULT 1,
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
      next_step TEXT NOT NULL DEFAULT '',
      action_owner TEXT,
      impact TEXT NOT NULL DEFAULT '',
      next_after TEXT NOT NULL DEFAULT '',
      options TEXT,
      context TEXT NOT NULL DEFAULT '',
      annotation TEXT,
      annotation_kind TEXT,
      annotated_at TEXT,
      snoozed_until TEXT,
      outcome TEXT NOT NULL DEFAULT '',
      outcome_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      action_started_at TEXT,
      action_version INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1,
      history TEXT,
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
      last_doing TEXT NOT NULL DEFAULT '',
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
  // issue #45 — the second activity stamp. NULL means "this session has not made
  // a tool call since the column existed": a brand-new presence row (registered
  // before the first call) and every row written by a server process still
  // running the old code. Both fall back to `started_at`, so a fresh connection
  // is never born cold and a days-old legacy claim is.
  ensureColumn(db, 'activity', 'last_call_at', 'TEXT')
  migrateActivitySynopsis(db)
  ensureColumn(db, 'items', 'context', `TEXT NOT NULL DEFAULT ''`)
  ensureColumn(db, 'items', 'next_step', `TEXT NOT NULL DEFAULT ''`)
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
  ensureColumn(db, 'boards', 'revision', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'board_rows', 'next_step', `TEXT NOT NULL DEFAULT ''`)
  ensureColumn(db, 'board_rows', 'options', 'TEXT')
  // issue #36 — the human's "I did my part" mark and its delivery mirror. Plain
  // additive columns: absence genuinely means "no value" (nobody has marked
  // anything), so unlike migrateAnnotationDelivery below there is nothing to
  // backfill and no flood to avoid.
  ensureColumn(db, 'board_rows', 'handled_at', 'TEXT')
  ensureColumn(db, 'board_rows', 'handled_seen_at', 'TEXT')
  ensureColumn(db, 'board_rows', 'handled_seen_by', 'TEXT')
  migrateActionLifecycle(db)
  migrateAnnotationDelivery(db)
}

// Additive migration for DBs created before the column existed. Good enough for
// a column whose absence means "no value" — but NOT for one that needs seeding:
// a migration that must BACKFILL has to ask hasColumn() itself and put the ALTER
// and the UPDATE in ONE transaction, or a crash between them leaves the column
// present and permanently empty. migrateAnnotationDelivery is the worked example.
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  if (hasColumn(db, table, column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]
  return cols.some((c) => c.name === column)
}

// `doing` is the current claim and must decay; `last_doing` is display-only
// history for the idle row. Seed legacy claims (and preserved idle details) so
// upgrading does not erase the only synopsis they ever reported. ALTER +
// backfill stay atomic: a crash between them would leave every existing session
// with an empty history and no migration replay path.
function migrateActivitySynopsis(db: Database.Database): void {
  db.transaction(() => {
    if (!hasColumn(db, 'activity', 'last_doing')) {
      db.exec(`ALTER TABLE activity ADD COLUMN last_doing TEXT NOT NULL DEFAULT ''`)
    }
    db.exec(`
      UPDATE activity
         SET last_doing = CASE
               WHEN idle = 0 AND doing <> '' AND doing <> 'open' THEN doing
               ELSE detail
             END
       WHERE last_doing = ''
         AND (
           (idle = 0 AND doing <> '' AND doing <> 'open')
           OR (idle = 1 AND detail <> '')
         )`)
  })()
}

function migrateActionLifecycle(db: Database.Database): void {
  db.transaction(() => {
    const add = (table: string, column: string, ddl: string): void => {
      if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    }
    add('items', 'action_owner', 'TEXT')
    add('items', 'impact', `TEXT NOT NULL DEFAULT ''`)
    add('items', 'next_after', `TEXT NOT NULL DEFAULT ''`)
    add('items', 'reply_kind', 'TEXT')
    add('items', 'snoozed_until', 'TEXT')
    add('items', 'outcome', `TEXT NOT NULL DEFAULT ''`)
    add('items', 'outcome_at', 'TEXT')
    add('items', 'updated_at', 'TEXT')

    add('board_rows', 'action_owner', 'TEXT')
    add('board_rows', 'impact', `TEXT NOT NULL DEFAULT ''`)
    add('board_rows', 'next_after', `TEXT NOT NULL DEFAULT ''`)
    add('board_rows', 'annotation_kind', 'TEXT')
    add('board_rows', 'snoozed_until', 'TEXT')
    add('board_rows', 'outcome', `TEXT NOT NULL DEFAULT ''`)
    add('board_rows', 'outcome_at', 'TEXT')
    add('board_rows', 'created_at', 'TEXT')
    add('board_rows', 'updated_at', 'TEXT')
    add('board_rows', 'action_started_at', 'TEXT')
    add('board_rows', 'action_version', 'INTEGER NOT NULL DEFAULT 1')
    add('board_rows', 'revision', 'INTEGER NOT NULL DEFAULT 1')
    add('board_rows', 'history', 'TEXT')

    db.exec(`
      UPDATE items
         SET updated_at = COALESCE(NULLIF(updated_at, ''), resolved_at, replied_at, created_at)
       WHERE updated_at IS NULL OR updated_at = '';

      UPDATE board_rows
         SET created_at = COALESCE(
               NULLIF(created_at, ''),
               (SELECT b.created_at FROM boards b WHERE b.id = board_rows.board_id)),
             updated_at = COALESCE(
               NULLIF(updated_at, ''),
               annotated_at,
               handled_at,
               (SELECT b.updated_at FROM boards b WHERE b.id = board_rows.board_id),
               (SELECT b.created_at FROM boards b WHERE b.id = board_rows.board_id)),
             action_started_at = COALESCE(
               NULLIF(action_started_at, ''),
               NULLIF(created_at, ''),
               (SELECT b.created_at FROM boards b WHERE b.id = board_rows.board_id)),
             action_version = COALESCE(action_version, 1),
             revision = COALESCE(revision, 1),
             history = COALESCE(history, '[]')
       WHERE created_at IS NULL OR created_at = ''
          OR updated_at IS NULL OR updated_at = ''
          OR action_started_at IS NULL OR action_started_at = ''
          OR history IS NULL;
    `)
  })()
}

// ── issue #37: board-level "read" → per-ROW "delivered" ──────────────────────
//
// `annotation_unseen` used to derive from BOARD-level `boards.last_read_at`, so
// one board_get marked every row's annotation seen — including rows the agent
// never looked at, and (title-less board_get) every board in the project at once.
// The per-row stamp is the honest model items already had via reply_seen_at.
//
// THE BACKFILL IS THE WHOLE RISK. Introduce the column NULL-for-all and every
// existing annotation reads as undelivered — so the first `pending()` poll hands
// week-old, already-superseded instructions ("merge it", "spec approved") to a
// live agent that will act on them. That is not a badge flood; it is an agent
// merging something. So the column is seeded from the EXACT inverse of the old
// withUnseen predicate, including its `annotated_at IS NULL` branch:
//   previously SEEN   → annotation_seen_at = the board's last_read_at (a real stamp)
//   previously UNSEEN → NULL, still deliverable
//
// ALTER + backfill are ONE transaction on purpose: a crash between them would
// leave the column present and empty forever, i.e. the flood, permanently, with
// no replay path. It runs inside migrate(), before any read path can touch it.
function migrateAnnotationDelivery(db: Database.Database): void {
  if (hasColumn(db, 'board_rows', 'annotation_seen_at')) {
    ensureColumn(db, 'board_rows', 'annotation_seen_by', 'TEXT')
    return
  }
  db.transaction(() => {
    db.exec(`ALTER TABLE board_rows ADD COLUMN annotation_seen_at TEXT`)
    if (!hasColumn(db, 'board_rows', 'annotation_seen_by')) db.exec(`ALTER TABLE board_rows ADD COLUMN annotation_seen_by TEXT`)
    db.exec(`
      UPDATE board_rows SET annotation_seen_at = (SELECT b.last_read_at FROM boards b WHERE b.id = board_rows.board_id)
       WHERE annotation IS NOT NULL AND annotation <> ''
         AND EXISTS (
           SELECT 1 FROM boards b
            WHERE b.id = board_rows.board_id
              AND b.last_read_at IS NOT NULL
              AND (board_rows.annotated_at IS NULL OR board_rows.annotated_at <= b.last_read_at))`)
  })()
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
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO items (
       id, project, stream, agent, session, kind, title, detail, next_step,
       action_owner, impact, next_after, context, options, repo, issue_ref,
       status, created_at, updated_at)
     VALUES (
       @id, @project, @stream, @agent, @session, @kind, @title, @detail, @next_step,
       @action_owner, @impact, @next_after, @context, @options, @repo, @issue_ref,
       'open', @created_at, @updated_at)`,
  ).run({
    id,
    project: item.project,
    stream: item.stream,
    agent: item.agent,
    session: item.session ?? null,
    kind: item.kind,
    title: item.title,
    detail: item.detail ?? '',
    next_step: item.next_step ?? '',
    action_owner: item.action_owner ?? null,
    impact: item.impact ?? '',
    next_after: item.next_after ?? '',
    context: item.context ?? '',
    options: item.options?.length ? JSON.stringify(item.options) : null,
    repo: item.repo ?? null,
    issue_ref: item.issue_ref ?? null,
    created_at: now,
    updated_at: now,
  })
  return id
}

// Returns false when the write was refused, true otherwise — so a caller
// (the viewer's POST handler) can surface a refusal instead of a silent no-op.
export function replyItem(
  db: Database.Database,
  id: string,
  text: string,
  context?: string,
  kind: ResponseKind = 'answer',
): boolean {
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
  const now = new Date().toISOString()
  if (!reply) {
    // atomic: the guard condition (reply_seen_at IS NULL) is checked and acted on in the
    // SAME statement as the write, so a concurrent markReplySeen from another connection
    // (e.g. the MCP server's `pending` handler, its own OS process) can never land in a
    // window between a read and a later, unconditional write — there is no such window.
    const info = db
      .prepare(`UPDATE items
                   SET reply = NULL, reply_context = NULL, replied_at = ?, reply_seen_at = NULL,
                       reply_source = NULL, reply_kind = NULL, updated_at = ?
                 WHERE id = ? AND reply_seen_at IS NULL`)
      .run(now, now, id)
    return info.changes > 0
  }
  // unconditional by design: the inbox is the higher-precedence channel, so the
  // human's own reply overwrites anything an agent recorded from chat (#29) and
  // resets pickup so that agent has to read the new one.
  db.prepare(`UPDATE items
                 SET reply = ?, reply_context = ?, replied_at = ?, reply_seen_at = NULL,
                     reply_source = 'inbox', reply_kind = ?, snoozed_until = NULL, updated_at = ?
               WHERE id = ?`)
    .run(reply, replyContext || null, now, kind, now, id)
  return true
}

// Compare-and-swap on the answer's own version stamp, in ONE statement (issue
// #37). This used to be an unconditional `WHERE id = ?`, while replyItem resets
// reply_seen_at = NULL from the VIEWER's separate OS process: a reply the human
// revised between the agent's read and its stamp got marked picked up by an agent
// that never saw it, and no later pending() would ever return it. Bind the exact
// replied_at the read returned and check the return value — false means the human
// moved it under you, so leave it undelivered and let the next poll carry it.
//
// `IS`, not `=`: replied_at is NULL on an item that has never been answered
// (test/viewer.test.ts stamps exactly that shape), and `= NULL` is never true.
export function markReplySeen(db: Database.Database, id: string, repliedAt: string | null): boolean {
  const info = db
    .prepare(`UPDATE items SET reply_seen_at = ? WHERE id = ? AND reply_seen_at IS NULL AND replied_at IS ?`)
    .run(new Date().toISOString(), id, repliedAt)
  return info.changes > 0
}

export type AnswerRefusal = 'empty' | 'not_found' | 'not_a_question' | 'not_open' | 'unread_inbox_answer'

export interface AnswerResult {
  ok: boolean
  reason?: AnswerRefusal
  // on 'unread_inbox_answer': the answer that is waiting, so the caller can act
  // on it without a second round-trip
  reply?: string | null
  reply_context?: string | null
  reply_kind?: ResponseKind | null
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
export function answerItem(
  db: Database.Database,
  id: string,
  text: string,
  context?: string,
  kind: ResponseKind = 'answer',
): AnswerResult {
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
      `UPDATE items
          SET reply = ?, reply_context = ?, replied_at = ?, reply_seen_at = ?,
              reply_source = 'agent', reply_kind = ?, snoozed_until = NULL, updated_at = ?
       WHERE id = ? AND kind = 'question' AND status = 'open'
         AND (reply IS NULL OR reply = '' OR reply_seen_at IS NOT NULL)`,
    )
    .run(reply, context?.trim() || null, now, now, kind, now, id)
  if (info.changes > 0) return { ok: true }
  // Diagnosis is advisory and deliberately runs AFTER the write. Reading first to
  // decide would reopen exactly the TOCTOU window the conditioned UPDATE closes;
  // since nothing was written, a concurrent change here can only make the
  // explanation stale, never the stored state wrong.
  const row = db.prepare(`SELECT kind, status, reply, reply_context, reply_kind FROM items WHERE id = ?`).get(id) as
    | { kind: Kind; status: Status; reply: string | null; reply_context: string | null; reply_kind: ResponseKind | null }
    | undefined
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.kind !== 'question') return { ok: false, reason: 'not_a_question' }
  if (row.status !== 'open') return { ok: false, reason: 'not_open' }
  return {
    ok: false,
    reason: 'unread_inbox_answer',
    reply: row.reply,
    reply_context: row.reply_context,
    reply_kind: row.reply_kind,
  }
}

export function listPending(db: Database.Database, project: string): Item[] {
  const rows = db
    .prepare(`SELECT * FROM items WHERE status = 'open' AND kind = 'question' AND project = ? ORDER BY created_at ASC`)
    .all(project)
  return (rows as Array<Omit<Item, 'options'> & { options: string | null }>).map(parseItem)
}

function parseItem(row: Omit<Item, 'options'> & { options: string | null }): Item {
  return { ...row, options: parseOptions(row.options) }
}

function parseOptions(raw: string | null): QuestionOption[] | null {
  return raw ? (JSON.parse(raw) as QuestionOption[]) : null
}

export function getItem(db: Database.Database, id: string): Item | null {
  const row = db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as
    | (Omit<Item, 'options'> & { options: string | null })
    | undefined
  return row ? parseItem(row) : null
}

export function resolveItem(db: Database.Database, id: string, outcome?: string): void {
  const now = new Date().toISOString()
  const text = outcome?.trim() ?? ''
  db.prepare(`UPDATE items
                 SET status = 'resolved',
                     resolved_at = COALESCE(resolved_at, @now),
                     updated_at = CASE
                       WHEN status IS NOT 'resolved'
                         OR (@text <> '' AND outcome IS NOT @text)
                       THEN @now ELSE updated_at END,
                     outcome = CASE WHEN @text <> '' THEN @text ELSE outcome END,
                     outcome_at = CASE
                       WHEN @text = '' OR outcome IS @text THEN outcome_at
                       ELSE @now END
               WHERE id = @id`)
    .run({ now, text, id })
}

export function dismissItem(db: Database.Database, id: string): void {
  db.prepare(`UPDATE items SET status = 'dismissed', updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id)
}

export function annotateItem(db: Database.Database, id: string, text: string): void {
  db.prepare(`UPDATE items SET annotation = ?, updated_at = ? WHERE id = ?`)
    .run(text, new Date().toISOString(), id)
}

export function snoozeItem(db: Database.Database, id: string, until: string | null): boolean {
  const info = db.prepare(`UPDATE items SET snoozed_until = ?, updated_at = ? WHERE id = ? AND status = 'open'`)
    .run(until, new Date().toISOString(), id)
  return info.changes > 0
}

export function listItems(db: Database.Database, opts: { status?: Status } = {}): Item[] {
  const rows = opts.status
    ? db.prepare(`SELECT * FROM items WHERE status = ? ORDER BY created_at DESC`).all(opts.status)
    : db.prepare(`SELECT * FROM items ORDER BY created_at DESC`).all()
  return (rows as Array<Omit<Item, 'options'> & { options: string | null }>).map(parseItem)
}

// 'blocked' = the row needs human input and escalates into the attention layer
export type RowStatus = 'done' | 'partial' | 'missing' | 'tracked' | 'na' | 'blocked'

export interface RowActionHistory {
  version: number
  status: RowStatus
  note: string
  next_step: string
  action_owner: ActionOwner | null
  impact: string
  next_after: string
  options: QuestionOption[] | null
  response_kind: ResponseKind | null
  response: string | null
  response_at: string | null
  picked_up_at: string | null
  handled: boolean
  outcome: string
  outcome_at: string | null
  started_at: string
  ended_at: string
}

export interface Board {
  id: string
  project: string
  stream: string
  agent: string
  title: string
  status: 'active' | 'archived'
  revision: number
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
  next_step: string
  action_owner: ActionOwner | null
  impact: string
  next_after: string
  options: QuestionOption[] | null
  context: string
  annotation: string | null
  annotation_kind: ResponseKind | null
  annotated_at: string | null
  // issue #37 — DELIVERY, not acknowledgement: "this text was handed to some
  // agent", and who it went to. It silences nothing on the human's side; the row
  // stays blocked until an agent flips its status, which is the acknowledgement.
  annotation_seen_at: string | null
  annotation_seen_by: string | null
  // issue #36 — the human's OTHER answer on a blocked row: not words, but "I went
  // and did my part". Deliberately NOT called done: `status: 'done'` is the
  // AGENT's assertion that the row's work is finished, and only an agent may set
  // it. This says the human's half is finished and the row is now waiting on an
  // agent to acknowledge by flipping that status. Same delivery mirror as the
  // annotation, and for the same reason (#37): the age of `handled_seen_at` is
  // the evidence that an agent has known for three hours and done nothing.
  handled_at: string | null
  handled_seen_at: string | null
  handled_seen_by: string | null
  snoozed_until: string | null
  outcome: string
  outcome_at: string | null
  created_at: string
  updated_at: string
  action_started_at: string
  action_version: number
  revision: number
  history: RowActionHistory[]
  position: number
  annotation_unseen: boolean
}

type BoardRowRecord = Omit<BoardRow, 'annotation_unseen' | 'options' | 'history'> & {
  options: string | null
  history: string | null
}

const ROW_COLUMNS = `
  id, label, status, note, next_step, action_owner, impact, next_after, options,
  context, annotation, annotation_kind, annotated_at, annotation_seen_at,
  annotation_seen_by, handled_at, handled_seen_at, handled_seen_by, snoozed_until,
  outcome, outcome_at, created_at, updated_at, action_started_at, action_version,
  revision, history, position`

// An annotation is "unseen" until it has been DELIVERED to an agent. Per-row and
// nothing else: `boards.last_read_at` is deliberately not an input any more
// (issue #37 / #36). Two inputs would disagree the first time a row is stamped
// individually while a board is stamped wholesale, and the disagreement would be
// invisible — nothing renders last_read_at.
//
// #36's `handled_at` gets NO derived twin here on purpose. `annotation_unseen`
// exists because "is there text an agent has not been handed" cannot be read off
// `annotation` alone — it needs the emptiness rule above. The mark has no such
// rule: `handled_at != null && handled_seen_at == null` says it exactly, and one
// less derived field is one less thing that can disagree with its own inputs.
function withUnseen(rows: BoardRowRecord[]): BoardRow[] {
  return rows.map((r) => ({
    ...r,
    options: parseOptions(r.options),
    history: parseHistory(r.history),
    annotation_unseen: r.annotation != null && r.annotation !== '' && r.annotation_seen_at === null,
  }))
}

function parseHistory(raw: string | null): RowActionHistory[] {
  return raw ? (JSON.parse(raw) as RowActionHistory[]) : []
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
  revision?: number
  note?: string
  next_step?: string
  action_owner?: ActionOwner | null
  impact?: string
  next_after?: string
  options?: QuestionOption[]
  outcome?: string
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
  expectedVersion?: number
  // optional on the WRITE shape: every pre-#30 call site passes neither
  repo?: string | null
  issueRef?: number | null
}

export function upsertBoard(db: Database.Database, input: UpsertBoardInput): { boardId: string; rowCount: number } {
  const run = db.transaction((inp: UpsertBoardInput): { boardId: string; rowCount: number } => {
    const labels = new Set(inp.rows.map((row) => row.label))
    if (labels.size !== inp.rows.length) throw new Error(`duplicate board row label in "${inp.title}"`)
    const now = new Date().toISOString()
    const before = findBoard(db, inp.project, inp.title)
    if (before && inp.expectedVersion !== before.revision) {
      throw new Error(`board version mismatch for "${inp.title}": expected ${String(inp.expectedVersion)}, found ${before.revision}`)
    }
    let boardChanged = !before
      || before.stream !== inp.stream
      || before.agent !== inp.agent
      || before.repo !== (inp.repo ?? null)
      || before.issue_ref !== (inp.issueRef ?? null)
    const boardId = ensureBoard(db, inp, now)
    const existing = db.prepare(`SELECT id, label, status, note, position, action_version, revision FROM board_rows WHERE board_id = ?`).all(boardId) as Array<{
      id: string
      label: string
      status: RowStatus
      note: string
      position: number
      action_version: number
      revision: number
    }>
    const idByLabel = new Map(existing.map((r) => [r.label, r]))
    const incoming = new Set<string>()
    inp.rows.forEach((r, i) => {
      incoming.add(r.label)
      const prev = idByLabel.get(r.label)
      if (prev) {
        const existingId = prev.id
        if (r.revision !== prev.revision) {
          throw new Error(`board row revision mismatch for "${r.label}": expected ${r.revision}, found ${prev.revision}`)
        }
        const newAction = r.status === 'blocked' && prev.status !== 'blocked'
        if (newAction) beginNewRowAction(db, existingId, now)
        let rowChanged = newAction
          || prev.status !== r.status
          || prev.note !== (r.note ?? prev.note)
          || prev.position !== i
        // annotation column is deliberately NOT touched — human notes survive
        db.prepare(`
          UPDATE board_rows
             SET status = @status,
                 note = @note,
                 position = @position,
                 updated_at = CASE
                   WHEN status IS NOT @status OR note IS NOT @note OR position IS NOT @position
                   THEN @now ELSE updated_at END
           WHERE id = @id`).run({
          status: r.status,
          note: r.note ?? prev.note,
          position: i,
          now,
          id: existingId,
        })
        // `next_step` is new and older agents do not know to echo it during a
        // full-table refresh. Omission therefore preserves it; an explicit ''
        // clears it, matching the context field's compatibility rule.
        rowChanged = updateRowTextField(db, existingId, 'next_step', r.next_step, now) || rowChanged
        rowChanged = updateRowTextField(db, existingId, 'impact', r.impact, now) || rowChanged
        rowChanged = updateRowTextField(db, existingId, 'next_after', r.next_after, now) || rowChanged
        if (r.action_owner !== undefined) {
          const info = db.prepare(`UPDATE board_rows SET action_owner = ?, updated_at = ? WHERE id = ? AND action_owner IS NOT ?`)
            .run(r.action_owner, now, existingId, r.action_owner)
          rowChanged = info.changes > 0 || rowChanged
        }
        if (r.options !== undefined) {
          const encoded = r.options.length ? JSON.stringify(r.options) : null
          const info = db.prepare(`UPDATE board_rows SET options = ?, updated_at = ? WHERE id = ? AND options IS NOT ?`)
            .run(encoded, now, existingId, encoded)
          rowChanged = info.changes > 0 || rowChanged
        }
        // OMITTING `context` KEEPS WHAT IS STORED; only an explicit '' clears it
        // (issue #42). The rule that a row ABSENT from an upsert is deleted is
        // about ROWS and is untouched — this is about a FIELD, and omission is
        // not deletion. It matters because the prescribed flow is read-then-
        // re-upsert (`board_get` → `board_upsert`) and MCP reads no longer carry
        // `context` at all: an agent re-sending exactly what it was handed would
        // wipe every row's backstory. Action fields, including note, preserve on
        // omission; explicit empty values are the only erasure.
        rowChanged = updateRowTextField(db, existingId, 'context', r.context, now) || rowChanged
        if (r.outcome !== undefined) rowChanged = setRowOutcome(db, existingId, r.outcome, now) || rowChanged
        if (!newAction && rowChanged) incrementRowRevision(db, existingId)
        boardChanged = boardChanged || rowChanged
      } else {
        boardChanged = true
        db.prepare(`
          INSERT INTO board_rows (
            id, board_id, label, status, note, next_step, action_owner, impact,
            next_after, options, context, outcome, outcome_at, created_at,
            updated_at, action_started_at, action_version, revision, history, position)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, '[]', ?)`)
          .run(
            randomUUID(),
            boardId,
            r.label,
            r.status,
            r.note ?? '',
            r.next_step ?? '',
            r.action_owner ?? null,
            r.impact ?? '',
            r.next_after ?? '',
            r.options?.length ? JSON.stringify(r.options) : null,
            r.context ?? '',
            r.outcome?.trim() ?? '',
            r.outcome?.trim() ? now : null,
            now,
            now,
            now,
            i,
          )
      }
    })
    for (const r of existing) {
      if (incoming.has(r.label)) continue
      db.prepare(`DELETE FROM board_rows WHERE id = ?`).run(r.id)
      boardChanged = true
    }
    boardChanged = syncBoardStatus(db, boardId) || boardChanged
    if (before && boardChanged) bumpBoardRevision(db, boardId, now)
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
  expectedBoardVersion?: number
  status?: RowStatus
  expectedRevision?: number
  note?: string
  next_step?: string
  action_owner?: ActionOwner | null
  impact?: string
  next_after?: string
  options?: QuestionOption[]
  outcome?: string
  context?: string
  repo?: string | null
  issueRef?: number | null
}

type RowTextColumn = 'note' | 'next_step' | 'impact' | 'next_after' | 'context'

function updateRowTextField(
  db: Database.Database,
  rowId: string,
  column: RowTextColumn,
  value: string | undefined,
  now: string,
): boolean {
  if (value === undefined) return false
  const info = db.prepare(`UPDATE board_rows SET ${column} = ?, updated_at = ? WHERE id = ? AND ${column} IS NOT ?`)
    .run(value, now, rowId, value)
  return info.changes > 0
}

function setRowOutcome(db: Database.Database, rowId: string, outcome: string, now: string): boolean {
  const text = outcome.trim()
  const info = db.prepare(`UPDATE board_rows
                 SET outcome_at = CASE
                       WHEN @text = '' THEN NULL
                       ELSE @now END,
                     updated_at = @now,
                     outcome = @text
               WHERE id = @id AND outcome IS NOT @text`)
    .run({ text, now, id: rowId })
  return info.changes > 0
}

function incrementRowRevision(db: Database.Database, rowId: string): number {
  const row = db.prepare(`UPDATE board_rows SET revision = revision + 1 WHERE id = ? RETURNING revision`)
    .get(rowId) as { revision: number } | undefined
  if (!row) throw new Error(`board row not found: ${rowId}`)
  return row.revision
}

function bumpBoardRevision(db: Database.Database, boardId: string, now: string): number {
  const board = db.prepare(`UPDATE boards SET revision = revision + 1, updated_at = ? WHERE id = ? RETURNING revision`)
    .get(now, boardId) as { revision: number } | undefined
  if (!board) throw new Error(`board not found: ${boardId}`)
  return board.revision
}

function latestIso(...values: Array<string | null>): string | null {
  let latest: { value: string; at: number } | null = null
  for (const value of values) {
    if (!value) continue
    const at = Date.parse(value)
    if (!Number.isFinite(at)) continue
    if (!latest || at > latest.at) latest = { value, at }
  }
  return latest?.value ?? null
}

function beginNewRowAction(db: Database.Database, rowId: string, now: string): number {
  const raw = db.prepare(`SELECT ${ROW_COLUMNS} FROM board_rows WHERE id = ?`).get(rowId) as BoardRowRecord | undefined
  if (!raw) throw new Error(`board row not found: ${rowId}`)
  const row = withUnseen([raw])[0]!
  const responseKind = row.annotation_kind ?? (row.annotation || row.handled_at ? 'answer' : null)
  const snapshot: RowActionHistory = {
    version: row.action_version,
    status: row.status,
    note: row.note,
    next_step: row.next_step,
    action_owner: row.action_owner,
    impact: row.impact,
    next_after: row.next_after,
    options: row.options,
    response_kind: responseKind,
    response: row.annotation,
    response_at: latestIso(row.annotated_at, row.handled_at),
    picked_up_at: latestIso(row.annotation_seen_at, row.handled_seen_at),
    handled: Boolean(row.handled_at),
    outcome: row.outcome,
    outcome_at: row.outcome_at,
    started_at: row.action_started_at,
    ended_at: now,
  }
  const history = [...row.history, snapshot]
  const nextVersion = row.action_version + 1
  db.prepare(`
    UPDATE board_rows
       SET note = '',
           next_step = '',
           action_owner = NULL,
           impact = '',
           next_after = '',
           options = NULL,
           annotation = NULL,
           annotation_kind = NULL,
           annotated_at = NULL,
           annotation_seen_at = NULL,
           annotation_seen_by = NULL,
           handled_at = NULL,
           handled_seen_at = NULL,
           handled_seen_by = NULL,
           snoozed_until = NULL,
           outcome = '',
           outcome_at = NULL,
           action_started_at = ?,
           action_version = ?,
           revision = revision + 1,
           history = ?,
           updated_at = ?
     WHERE id = ?`)
    .run(now, nextVersion, JSON.stringify(history), now, rowId)
  return nextVersion
}

export interface AdvanceBoardRowInput {
  project: string
  title: string
  label: string
  expectedBoardVersion: number
  expectedRevision: number
  note: string
  next_step: string
  action_owner: ActionOwner
  impact: string
  next_after?: string
  options?: QuestionOption[]
  context?: string
}

export type AdvanceBoardRowResult =
  | { ok: true; action_version: number; revision: number }
  | {
      ok: false
      reason: 'not_found' | 'version_mismatch' | 'board_version_mismatch'
      revision?: number
      board_revision?: number
    }

export function advanceBoardRow(
  db: Database.Database,
  input: AdvanceBoardRowInput,
): AdvanceBoardRowResult {
  const run = db.transaction((inp: AdvanceBoardRowInput): AdvanceBoardRowResult => {
    const board = findBoard(db, inp.project, inp.title)
    if (!board || board.status !== 'active') return { ok: false, reason: 'not_found' }
    if (board.revision !== inp.expectedBoardVersion) {
      return { ok: false, reason: 'board_version_mismatch', board_revision: board.revision }
    }
    const raw = db.prepare(`SELECT ${ROW_COLUMNS} FROM board_rows WHERE board_id = ? AND label = ?`)
      .get(board.id, inp.label) as BoardRowRecord | undefined
    if (!raw) return { ok: false, reason: 'not_found' }
    const row = withUnseen([raw])[0]!
    if (row.revision !== inp.expectedRevision) {
      return { ok: false, reason: 'version_mismatch', revision: row.revision }
    }
    const now = new Date().toISOString()
    const version = beginNewRowAction(db, row.id, now)
    db.prepare(`
      UPDATE board_rows
         SET status = 'blocked',
             note = ?,
             next_step = ?,
             action_owner = ?,
             impact = ?,
             next_after = ?,
             options = ?,
             context = CASE WHEN ? IS NULL THEN context ELSE ? END,
             updated_at = ?
       WHERE id = ?`)
      .run(
        inp.note,
        inp.next_step,
        inp.action_owner,
        inp.impact,
        inp.next_after ?? '',
        inp.options?.length ? JSON.stringify(inp.options) : null,
        inp.context ?? null,
        inp.context ?? null,
        now,
        row.id,
      )
    syncBoardStatus(db, board.id)
    bumpBoardRevision(db, board.id, now)
    const revision = (db.prepare(`SELECT revision FROM board_rows WHERE id = ?`).get(row.id) as { revision: number }).revision
    return { ok: true, action_version: version, revision }
  })
  return run.immediate(input)
}

export function updateBoardRow(db: Database.Database, input: UpdateRowInput): { boardId: string; rowId: string } {
  const run = db.transaction((inp: UpdateRowInput): { boardId: string; rowId: string } => {
    const now = new Date().toISOString()
    const before = findBoard(db, inp.project, inp.title)
    if (before && inp.expectedBoardVersion !== before.revision) {
      throw new Error(`board version mismatch for "${inp.title}": expected ${String(inp.expectedBoardVersion)}, found ${before.revision}`)
    }
    const metadataChanged = Boolean(before) && (
      before!.stream !== inp.stream
      || before!.agent !== inp.agent
      || before!.repo !== (inp.repo ?? null)
      || before!.issue_ref !== (inp.issueRef ?? null)
    )
    const boardId = ensureBoard(db, inp, now)
    const existing = db.prepare(`SELECT id, status, action_version, revision FROM board_rows WHERE board_id = ? AND label = ?`).get(boardId, inp.label) as {
      id: string
      status: RowStatus
      action_version: number
      revision: number
    } | undefined
    if (existing) {
      if (inp.expectedRevision !== existing.revision) {
        throw new Error(`board row revision mismatch for "${inp.label}": expected ${inp.expectedRevision}, found ${existing.revision}`)
      }
      let newAction = false
      let rowChanged = false
      if (inp.status !== undefined) {
        newAction = inp.status === 'blocked' && existing.status !== 'blocked'
        if (newAction) beginNewRowAction(db, existing.id, now)
        const info = db.prepare(`UPDATE board_rows SET status = ?, updated_at = ? WHERE id = ? AND status IS NOT ?`)
          .run(inp.status, now, existing.id, inp.status)
        rowChanged = newAction || info.changes > 0
      }
      rowChanged = updateRowTextField(db, existing.id, 'note', inp.note, now) || rowChanged
      rowChanged = updateRowTextField(db, existing.id, 'next_step', inp.next_step, now) || rowChanged
      rowChanged = updateRowTextField(db, existing.id, 'impact', inp.impact, now) || rowChanged
      rowChanged = updateRowTextField(db, existing.id, 'next_after', inp.next_after, now) || rowChanged
      if (inp.action_owner !== undefined) {
        const info = db.prepare(`UPDATE board_rows SET action_owner = ?, updated_at = ? WHERE id = ? AND action_owner IS NOT ?`)
          .run(inp.action_owner, now, existing.id, inp.action_owner)
        rowChanged = info.changes > 0 || rowChanged
      }
      if (inp.options !== undefined) {
        const encoded = inp.options.length ? JSON.stringify(inp.options) : null
        const info = db.prepare(`UPDATE board_rows SET options = ?, updated_at = ? WHERE id = ? AND options IS NOT ?`)
          .run(encoded, now, existing.id, encoded)
        rowChanged = info.changes > 0 || rowChanged
      }
      rowChanged = updateRowTextField(db, existing.id, 'context', inp.context, now) || rowChanged
      if (inp.outcome !== undefined) rowChanged = setRowOutcome(db, existing.id, inp.outcome, now) || rowChanged
      if (!newAction && rowChanged) incrementRowRevision(db, existing.id)
      const boardChanged = syncBoardStatus(db, boardId) || rowChanged || metadataChanged
      if (boardChanged) bumpBoardRevision(db, boardId, now)
      return { boardId, rowId: existing.id }
    }
    const rowId = randomUUID()
    const pos = (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM board_rows WHERE board_id = ?`).get(boardId) as { p: number }).p
    db.prepare(`
      INSERT INTO board_rows (
        id, board_id, label, status, note, next_step, action_owner, impact,
        next_after, options, context, outcome, outcome_at, created_at, updated_at,
        action_started_at, action_version, revision, history, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, '[]', ?)`)
      .run(
        rowId,
        boardId,
        inp.label,
        inp.status ?? 'tracked',
        inp.note ?? '',
        inp.next_step ?? '',
        inp.action_owner ?? null,
        inp.impact ?? '',
        inp.next_after ?? '',
        inp.options?.length ? JSON.stringify(inp.options) : null,
        inp.context ?? '',
        inp.outcome?.trim() ?? '',
        inp.outcome?.trim() ? now : null,
        now,
        now,
        now,
        pos,
      )
    syncBoardStatus(db, boardId)
    if (before) bumpBoardRevision(db, boardId, now)
    return { boardId, rowId }
  })
  return run(input)
}

// After every agent write, a board's active/archived status follows its
// completeness: 100% (with countable rows) → archived immediately (the human's
// chosen lifecycle); anything less → active, which also resurrects an archived
// board the agent is still writing to (the "flickered to 100% mid-update" case).
function syncBoardStatus(db: Database.Database, boardId: string): boolean {
  const rows = db.prepare(`SELECT status FROM board_rows WHERE board_id = ?`).all(boardId) as { status: RowStatus }[]
  const p = computeProgress(rows as BoardRow[])
  const complete = p.countable > 0 && p.fraction === 1
  const next = complete ? 'archived' : 'active'
  const current = db.prepare(`SELECT status FROM boards WHERE id = ?`).get(boardId) as { status: 'active' | 'archived' } | undefined
  if (!current || current.status === next) return false
  db.prepare(`UPDATE boards SET status = ?, updated_at = ? WHERE id = ?`)
    .run(next, new Date().toISOString(), boardId)
  return true
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
    db.prepare(`UPDATE boards
                   SET stream = ?, agent = ?, repo = ?, issue_ref = ?,
                       updated_at = CASE
                         WHEN stream IS NOT ? OR agent IS NOT ? OR repo IS NOT ? OR issue_ref IS NOT ?
                         THEN ? ELSE updated_at END
                 WHERE id = ?`)
      .run(
        inp.stream,
        inp.agent,
        inp.repo ?? null,
        inp.issueRef ?? null,
        inp.stream,
        inp.agent,
        inp.repo ?? null,
        inp.issueRef ?? null,
        now,
        board.id,
      )
    return board.id
  }
  const boardId = randomUUID()
  db.prepare(`INSERT INTO boards (id, project, stream, agent, title, repo, issue_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run(boardId, inp.project, inp.stream, inp.agent, inp.title, inp.repo ?? null, inp.issueRef ?? null, now, now)
  return boardId
}

export function archiveBoard(db: Database.Database, boardId: string, expectedRevision: number): boolean {
  const info = db.prepare(`UPDATE boards
                              SET status = 'archived', revision = revision + 1, updated_at = ?
                            WHERE id = ? AND revision = ?`)
    .run(new Date().toISOString(), boardId, expectedRevision)
  return info.changes > 0
}

export function unarchiveBoard(db: Database.Database, boardId: string, expectedRevision: number): boolean {
  const info = db.prepare(`UPDATE boards
                              SET status = 'active', revision = revision + 1, updated_at = ?
                            WHERE id = ? AND revision = ?`)
    .run(new Date().toISOString(), boardId, expectedRevision)
  return info.changes > 0
}

// New text resets delivery IN THE SAME STATEMENT that writes it (the replyItem
// invariant, for rows). Split them and a re-annotation of an already-delivered
// row inherits the old stamp and is never handed to anyone.
export function annotateBoardRow(
  db: Database.Database,
  rowId: string,
  text: string,
  kind: ResponseKind = 'answer',
  expectedRevision?: number,
  expectedBoardRevision?: number,
): boolean {
  const now = new Date().toISOString()
  const annotation = text.trim()
  const run = db.transaction((): boolean => {
    const row = db.prepare(`UPDATE board_rows
                               SET annotation = ?, annotation_kind = ?, annotated_at = ?,
                                   annotation_seen_at = NULL, annotation_seen_by = NULL,
                                   snoozed_until = NULL, updated_at = ?, revision = revision + 1
                             WHERE id = ? AND (? IS NULL OR revision = ?)
                               AND EXISTS (
                                 SELECT 1 FROM boards b
                                  WHERE b.id = board_rows.board_id
                                    AND b.status = 'active'
                                    AND (? IS NULL OR b.revision = ?))
                             RETURNING board_id`)
      .get(
        annotation,
        annotation ? kind : null,
        now,
        now,
        rowId,
        expectedRevision ?? null,
        expectedRevision ?? null,
        expectedBoardRevision ?? null,
        expectedBoardRevision ?? null,
      ) as { board_id: string } | undefined
    if (!row) return false
    bumpBoardRevision(db, row.board_id, now)
    return true
  })
  return run.immediate()
}

export function snoozeBoardRow(
  db: Database.Database,
  rowId: string,
  until: string | null,
  expectedRevision?: number,
  expectedBoardRevision?: number,
): boolean {
  const now = new Date().toISOString()
  const run = db.transaction((): boolean => {
    const row = db.prepare(`UPDATE board_rows
                               SET snoozed_until = ?, updated_at = ?, revision = revision + 1
                             WHERE id = ? AND status = 'blocked'
                               AND (? IS NULL OR revision = ?)
                               AND annotation IS NULL AND annotation_kind IS NULL
                               AND handled_at IS NULL
                               AND EXISTS (
                                 SELECT 1 FROM boards b
                                  WHERE b.id = board_rows.board_id
                                    AND b.status = 'active'
                                    AND (? IS NULL OR b.revision = ?))
                             RETURNING board_id`)
      .get(
        until,
        now,
        rowId,
        expectedRevision ?? null,
        expectedRevision ?? null,
        expectedBoardRevision ?? null,
        expectedBoardRevision ?? null,
      ) as { board_id: string } | undefined
    if (!row) return false
    bumpBoardRevision(db, row.board_id, now)
    return true
  })
  return run.immediate()
}

// ── issue #36: the human's "I did my part" mark ─────────────────────────────
//
// WHY IT IS NOT A STATUS. The task-shaped blockers that motivated #36 — "create
// the Paddle account", "register the Notion integration", "record the hero
// demo" — do not want words, they want DONE. Decision-shaped blockers now carry
// direct options and land as an annotation instead; this field remains the
// human's completion signal for TASKS. `status: 'done'` is the agent's assertion
// about the ROW and only agents may write it, so the human's half needs its own
// field. This is that field.
//
// THE INVARIANT: `upsertBoard` can never clear it, exactly like `annotation`.
// The prescribed agent flow is a full-table re-send, so "any write mentioning
// this row drops the mark" would erase the human's action on every routine
// refresh — the omitted-field-means-delete failure #42 had to fix at the root,
// wearing a different hat.
export function markRowHandled(
  db: Database.Database,
  rowId: string,
  expectedRevision?: number,
  expectedBoardRevision?: number,
): boolean {
  // New mark, new delivery — the same statement, for annotateBoardRow's reason:
  // split them and a re-mark on an already-delivered row inherits the old stamp
  // and reads "delivered" to the human before anyone has been told.
  const now = new Date().toISOString()
  const run = db.transaction((): boolean => {
    const row = db.prepare(`UPDATE board_rows
                 SET handled_at = ?, handled_seen_at = NULL, handled_seen_by = NULL,
                     snoozed_until = NULL, updated_at = ?, revision = revision + 1
               WHERE id = ? AND (? IS NULL OR revision = ?)
                 AND EXISTS (
                   SELECT 1 FROM boards b
                    WHERE b.id = board_rows.board_id
                      AND b.status = 'active'
                      AND (? IS NULL OR b.revision = ?))
               RETURNING board_id`)
      .get(
        now,
        now,
        rowId,
        expectedRevision ?? null,
        expectedRevision ?? null,
        expectedBoardRevision ?? null,
        expectedBoardRevision ?? null,
      ) as { board_id: string } | undefined
    if (!row) return false
    bumpBoardRevision(db, row.board_id, now)
    return true
  })
  return run.immediate()
}

// The undo, and the ONLY thing that can take the mark back. Guarded in the SAME
// statement it writes (replyItem's blank-guard precedent, not a read-then-write):
// the MCP server stamps delivery from its own OS process, so a check up here
// would be a TOCTOU window rather than a guard. `false` = an agent has already
// been handed the mark — un-marking cannot un-tell them, so refuse and let the
// caller say so out loud instead of pretending it worked.
//
// It does NOT require the mark to still be there: clearing an already-clear row
// reports success, so two tabs (or a double click) can never turn a harmless
// repeat into a "somebody picked this up" lie.
export function clearRowHandled(
  db: Database.Database,
  rowId: string,
  expectedRevision?: number,
  expectedBoardRevision?: number,
): boolean {
  const now = new Date().toISOString()
  const run = db.transaction((): boolean => {
    const row = db.prepare(`UPDATE board_rows
                 SET handled_at = NULL, handled_seen_at = NULL, handled_seen_by = NULL,
                     updated_at = ?, revision = revision + 1
               WHERE id = ? AND handled_seen_at IS NULL
                 AND (? IS NULL OR revision = ?)
                 AND EXISTS (
                   SELECT 1 FROM boards b
                    WHERE b.id = board_rows.board_id
                      AND b.status = 'active'
                      AND (? IS NULL OR b.revision = ?))
               RETURNING board_id`)
      .get(
        now,
        rowId,
        expectedRevision ?? null,
        expectedRevision ?? null,
        expectedBoardRevision ?? null,
        expectedBoardRevision ?? null,
      ) as { board_id: string } | undefined
    if (!row) return false
    bumpBoardRevision(db, row.board_id, now)
    return true
  })
  return run.immediate()
}

// markAnnotationDelivered's twin, same COALESCE (the stamp records the FIRST
// delivery and never moves, because its AGE is the evidence the human's card
// shows) and same version pin (the viewer can re-mark from another process
// between an agent's read and its stamp).
//
// Stricter in one place: `handled_at IS NOT NULL`. markAnnotationDelivered
// deliberately tolerates a NULL pin because real pre-`annotated_at` rows exist in
// the wild; this column has no legacy, so a NULL pin can only mean "you are
// stamping a row that carries no mark" and is refused.
export function markHandledDelivered(
  db: Database.Database,
  rowId: string,
  handledAt: string | null,
  by: string | null,
): boolean {
  const info = db
    .prepare(`UPDATE board_rows SET handled_seen_at = COALESCE(handled_seen_at, ?),
                                    handled_seen_by = COALESCE(handled_seen_by, ?)
               WHERE id = ? AND handled_at IS NOT NULL AND handled_at IS ?`)
    .run(new Date().toISOString(), by, rowId, handledAt)
  return info.changes > 0
}

// The ONE rule that decides when the human's mark dies: a NEW ask, and nothing
// else — a row that was NOT blocked and now is. Re-sending a row that is already
// blocked is not an acknowledgement (both board tool descriptions say so) and
// must therefore not reset anything, or every routine full-table refresh would
// quietly undo the human's action. Flipping the status is the acknowledgement;
// blocking it again afterwards is a fresh request, so it starts from nothing.
// The rows-shaped twin of markReplySeen, version-pinned for the same reason: the
// viewer writes annotations from its own OS process, so a SELECT-then-UPDATE
// would stamp text that no longer exists and bury the human's newest instruction
// forever. ONE statement, pinning the exact version the caller read.
//
// It is NOT markReplySeen's exact shape, and the difference is deliberate. That
// one also carries `AND reply_seen_at IS NULL`, so it stamps once and reports
// whether it won. This one drops that clause (see COALESCE below) because for
// rows a second delivery is the normal case, not a lost race.
//
// The return value means EXACTLY ONE THING: the text you read is still the text
// that is there, so it is safe to hand over. `false` = the human replaced it
// under you — drop it, and the newer text stays queued. It deliberately does NOT
// mean "you were the first reader": since rows became at-least-once (F1 below),
// a re-delivery is normal and must not be mistaken for a lost race.
//
// COALESCE, not a plain SET, is what keeps those two apart. The stamp records the
// FIRST delivery and never moves, because its age is what the human's chip shows
// ("delivered to claude-code 3h ago") — and that age is the evidence that an
// agent has had the answer for three hours and done nothing. Re-stamping every
// poll would make it read "delivered moments ago" forever and hide precisely the
// failure it exists to show.
//
// `IS`, not `=`: annotated_at is NULL on rows written before that column existed
// (real ones exist in the wild), and `annotated_at = NULL` is never true — a `=`
// pin would leave every legacy annotation unstampable, so it would never earn a
// "delivered to" attribution at all.
export function markAnnotationDelivered(
  db: Database.Database,
  rowId: string,
  annotatedAt: string | null,
  by: string | null,
): boolean {
  const info = db
    .prepare(`UPDATE board_rows SET annotation_seen_at = COALESCE(annotation_seen_at, ?),
                                    annotation_seen_by = COALESCE(annotation_seen_by, ?)
               WHERE id = ? AND annotated_at IS ?`)
    .run(new Date().toISOString(), by, rowId, annotatedAt)
  return info.changes > 0
}

// DECORATION since issue #37: "when did an agent last read this board" is a
// legitimate fact and the annotation-delivery migration's only input (dropping
// the column would make that backfill unreplayable), so it stays and keeps being
// written — but it no longer marks anything seen. Nothing outside store.ts has
// ever CONSUMED it; it is merely carried along in the board payload.
export function markBoardRead(db: Database.Database, boardId: string): void {
  db.prepare(`UPDATE boards SET last_read_at = ? WHERE id = ?`).run(new Date().toISOString(), boardId)
}

// ── issue #37: the delivery queue for what the human said on a board row ────
//
// The human's per-row note used to be reachable only by an agent independently
// choosing to call board_get — guidance in a document, not a delivery mechanism.
// This is what `pending()` adds to its payload, project-scoped exactly as items
// are, so every agent already polling picks them up with no new discipline.
//
// It carries BOTH shapes the human can answer a row in (issue #36): the
// `annotation` (words) and the `handled_at` mark (they went and DID it). A mark
// the agent cannot see is the same dead end as an undeliverable note, so the two
// ride the same queue and the same at-least-once rule below.
//
// ACTIVE boards only, matching board_get (getBoard returns undefined for an
// archived board). syncBoardStatus auto-archives a board the moment it hits 100%,
// so an annotation on a completed board stays where the human left it rather than
// being re-delivered out of context.
//
// GATED ON THE ACKNOWLEDGEMENT, NOT ON THE DELIVERY STAMP — this is F1, and it is
// what makes rows AT-LEAST-ONCE like items instead of at-most-once. `listPending`
// keeps returning an answered question until the agent `resolve`s it; gating rows
// on `annotation_seen_at` instead meant the human's note went to exactly ONE poll
// from ONE session. This repo fans out subagents constantly, so a sibling's
// incidental poll silently ate the answer, the session that RAISED the row never
// received it, and the human's screen then read "delivered to claude-code" — the
// one signal that tells them to stop chasing it. The same window opened on a
// crash or client timeout between the stamp and the response.
//
// So: a row is pending while it is UNACKNOWLEDGED — some part of what the human
// left has not been handed over, OR it is still `blocked`. `blocked` is exactly the state the human is
// still looking at (public/attention.js keeps an annotated blocked row on screen
// in the awaiting-pickup foot until an agent flips it), so the agent's queue and
// the human's screen now go quiet on the SAME event. One rule, both surfaces.
//
// The two halves are deliberate, not a special case:
//   · blocked   → the human is waiting on you. Re-delivered until you flip the
//                 status with board_row, which IS the acknowledgement. An agent
//                 that acted without flipping keeps being told — and so does the
//                 human, who still sees the row. Neither is silently dropped.
//   · anything  → nothing to acknowledge; the note is an aside, not an answer.
//     else        Handed over once, then it stays put. Without this half a
//                 months-old aside on a live board would be a permanent firehose.
// The payload carries the delivery stamp so a re-delivery is self-labelling: an
// agent polling every few seconds can tell "new to me" from "I already have this".
export interface PendingRow {
  board_id: string
  board_title: string
  board_revision: number
  project: string
  stream: string
  agent: string
  row_id: string
  label: string
  status: RowStatus
  note: string
  next_step: string
  action_owner: ActionOwner | null
  impact: string
  next_after: string
  options: QuestionOption[] | null
  context: string
  // NULLABLE since #36: a row can reach this queue carrying only the human's
  // `handled_at` mark and no words at all. An agent that keys on `annotation`
  // being a string would then silently skip the very thing it is being told.
  annotation: string | null
  annotation_kind: ResponseKind | null
  annotated_at: string | null
  annotation_seen_at: string | null
  annotation_seen_by: string | null
  handled_at: string | null
  handled_seen_at: string | null
  handled_seen_by: string | null
  snoozed_until: string | null
  outcome: string
  outcome_at: string | null
  action_started_at: string
  action_version: number
  revision: number
  updated_at: string
}

export function listPendingRows(db: Database.Database, project: string): PendingRow[] {
  const now = new Date().toISOString()
  const rows = db
    .prepare(
      `SELECT b.id AS board_id, b.title AS board_title, b.revision AS board_revision,
              b.project AS project, b.stream AS stream, b.agent AS agent,
              r.id AS row_id, r.label AS label, r.status AS status, r.note AS note,
              r.next_step AS next_step, r.action_owner AS action_owner, r.impact AS impact,
              r.next_after AS next_after, r.options AS options, r.context AS context,
              r.annotation AS annotation, r.annotation_kind AS annotation_kind,
              r.annotated_at AS annotated_at,
              r.annotation_seen_at AS annotation_seen_at, r.annotation_seen_by AS annotation_seen_by,
              r.handled_at AS handled_at, r.handled_seen_at AS handled_seen_at,
              r.handled_seen_by AS handled_seen_by, r.snoozed_until AS snoozed_until,
              r.outcome AS outcome, r.outcome_at AS outcome_at,
              r.action_started_at AS action_started_at, r.action_version AS action_version,
              r.revision AS revision,
              r.updated_at AS updated_at
         FROM board_rows r JOIN boards b ON b.id = r.board_id
        WHERE b.project = ? AND b.status = 'active'
          AND (r.snoozed_until > ?
               OR r.annotation_kind IS NOT NULL
               OR (r.annotation IS NOT NULL AND r.annotation <> '')
               OR r.handled_at IS NOT NULL)
          AND (r.snoozed_until > ?
               OR r.status = 'blocked'
               OR ((r.annotation_kind IS NOT NULL OR (r.annotation IS NOT NULL AND r.annotation <> ''))
                   AND r.annotation_seen_at IS NULL)
               OR (r.handled_at IS NOT NULL AND r.handled_seen_at IS NULL))
        ORDER BY b.updated_at DESC, r.position ASC`,
    )
    .all(project, now, now) as Array<Omit<PendingRow, 'options'> & { options: string | null }>
  return rows.map((row) => ({ ...row, options: parseOptions(row.options) }))
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
  const rowStmt = db.prepare(`SELECT ${ROW_COLUMNS} FROM board_rows WHERE board_id = ? ORDER BY position ASC`)
  return boards.map((b) => {
    const rows = withUnseen(rowStmt.all(b.id) as BoardRowRecord[])
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
  /** Most recent explicit non-idle claim (or legacy idle detail); display only. */
  last_doing: string
  detail: string
  children: ActivityChild[]
  idle: boolean
  started_at: string
  updated_at: string
  /** last REAL MCP call (issue #45). NULL until this session makes one. */
  last_call_at: string | null
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
  /**
   * Is this write SPEAKING FOR THE AGENT, or merely saying the session is here?
   *
   * Default `true` — CLAIMING — and that half is unchanged: `status({doing})`
   * asserts a claim and `status({done:true})` legitimately revokes one back to
   * `doing: 'open'`, so both must overwrite whatever was there.
   *
   * `false` — REGISTERING — is the presence path in src/mcp.ts, which runs on the
   * initialize handshake AND on an unconditional 2-second fallback. It refreshes
   * scope, `updated_at` and `ended_at` only; `doing`, `last_doing`, `detail`,
   * `children` and `idle` are left exactly as the agent last set them. Without
   * this, a
   * `status({doing})` made in a session's first two seconds was wiped by the
   * fallback two seconds later.
   */
  claim?: boolean
}

export function upsertActivity(db: Database.Database, a: ActivityUpdate): void {
  const now = new Date().toISOString()
  // One statement, two modes. Registration can create idle presence but can
  // neither replace a live claim nor write its historical caption.
  db.prepare(
    `INSERT INTO activity (session, project, stream, agent, doing, last_doing, detail, children, idle, started_at, updated_at)
     VALUES (
       @session, @project, @stream, @agent, @doing,
       CASE WHEN @claim = 1 AND @idle = 0 AND @doing <> '' AND @doing <> 'open' THEN @doing ELSE '' END,
       @detail, @children, @idle, @now, @now
     )
     ON CONFLICT(session) DO UPDATE SET
       project = @project, stream = @stream, agent = @agent,
       doing    = CASE WHEN @claim = 1 THEN @doing ELSE doing END,
       last_doing = CASE
         WHEN @claim = 1 AND @idle = 0 AND @doing <> '' AND @doing <> 'open' THEN @doing
         ELSE last_doing
       END,
       detail   = CASE WHEN @claim = 1 THEN COALESCE(NULLIF(@detail, ''), detail) ELSE detail END,
       children = CASE WHEN @claim = 1 THEN COALESCE(@children, children) ELSE children END,
       idle     = CASE WHEN @claim = 1 THEN @idle ELSE idle END,
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
    claim: a.claim === false ? 0 : 1,
    now,
  })
  // housekeeping: rows dead (ended or silent) for over a day serve no one
  const dayAgo = new Date(Date.now() - 24 * 60 * 60000).toISOString()
  db.prepare(`DELETE FROM activity WHERE (ended_at IS NOT NULL AND ended_at < ?) OR updated_at < ?`).run(dayAgo, dayAgo)
}

export function endActivity(db: Database.Database, session: string): void {
  db.prepare(`UPDATE activity SET ended_at = ? WHERE session = ?`).run(new Date().toISOString(), session)
}

// heartbeat: keep a live session's row from going stale without changing it.
// LIVENESS ONLY (issue #45) — this is what the 5-minute timer in src/mcp.ts
// calls, and it must never touch `last_call_at`, or the two stamps collapse back
// into one and a `doing` claim becomes immortal again.
export function touchActivity(db: Database.Database, session: string): void {
  db.prepare(`UPDATE activity SET updated_at = ? WHERE session = ? AND ended_at IS NULL`).run(new Date().toISOString(), session)
}

// ── issue #45: how long a `doing` claim outlives its last real MCP call ──────
//
// 30 minutes, and the number is a floor on "silent but genuinely working", not a
// guess at "idle". An agent can work for a long stretch without touching this
// server at all — a 10-minute test run, a build, a heads-down edit loop — and a
// claim killed under a session that is still working is a new lie, so the
// threshold is deliberately generous: 6x the heartbeat interval, comfortably past
// the longest single Bash timeout, and past any fan-out gap (a subagent's calls
// are served by the parent CLI's process, so siblings bump this same row). What
// it buys is a bound: the claim can be wrong for half an hour instead of days,
// and any `status({doing})` re-asserts it instantly.
export const CLAIM_COLD_MS = 30 * 60000

const claimCutoff = (nowMs: number): string => new Date(nowMs - CLAIM_COLD_MS).toISOString()

// A REAL tool call: proof the agent is doing something, not just running.
//
// It writes both stamps, and it is also where a claim that already went cold is
// CLEARED rather than renewed. That half is not optional: decaying only on read
// would let any later poll re-list a two-day-old `doing` as live work, which is
// exactly the observed failure — the stale rows belonged to CLIs that were still
// calling. Expressed as one conditional UPDATE (never SELECT-then-UPDATE) so the
// clear and the stamp cannot be split. `last_doing` deliberately stays out of
// this UPDATE: it is a historical caption, never a current claim.
export function recordActivityCall(db: Database.Database, session: string): void {
  const now = new Date().toISOString()
  const cold = claimCutoff(Date.now())
  db.prepare(
    `UPDATE activity SET
       doing    = CASE WHEN COALESCE(last_call_at, started_at) < @cold THEN 'open' ELSE doing END,
       detail   = CASE WHEN COALESCE(last_call_at, started_at) < @cold THEN ''     ELSE detail END,
       children = CASE WHEN COALESCE(last_call_at, started_at) < @cold THEN NULL   ELSE children END,
       idle     = CASE WHEN COALESCE(last_call_at, started_at) < @cold THEN 1      ELSE idle END,
       last_call_at = @now,
       updated_at = @now
     WHERE session = @session AND ended_at IS NULL`,
  ).run({ session, now, cold })
}

export function listActivity(db: Database.Database, opts: { staleMinutes?: number } = {}): Activity[] {
  const now = Date.now()
  const cutoff = new Date(now - (opts.staleMinutes ?? 15) * 60000).toISOString()
  const cold = claimCutoff(now)
  const rows = db
    .prepare(`SELECT session, project, stream, agent, doing, last_doing, detail, children, idle, started_at, updated_at, last_call_at
              FROM activity WHERE ended_at IS NULL AND updated_at >= ?`)
    .all(cutoff) as Array<Omit<Activity, 'children' | 'idle'> & { children: string | null; idle: number }>
  // The row is kept whatever happens here — the session really is present, and
  // public/attention.js classifies an item as "waiting" iff its session id is in
  // this list, so dropping the row would silently downgrade a live blocker. Only
  // the CLAIM decays.
  const out = rows.map((r): Activity => {
    const live = (r.last_call_at ?? r.started_at) >= cold
    return {
      ...r,
      idle: live ? r.idle === 1 : true,
      doing: live ? r.doing : 'open',
      detail: live ? r.detail : '',
      children: live && r.children ? (JSON.parse(r.children) as ActivityChild[]) : [],
    }
  })
  // Working sessions first (longest-running first, as before). Everything else
  // sorts by how recently it actually did something, so the terminal somebody
  // left open on Tuesday sits at the bottom of the fold instead of the top.
  const lastActive = (a: Activity): string => a.last_call_at ?? a.started_at
  return out.sort((a, b) => {
    if (a.idle !== b.idle) return a.idle ? 1 : -1
    if (a.idle) return lastActive(a) < lastActive(b) ? 1 : lastActive(a) > lastActive(b) ? -1 : 0
    return a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0
  })
}

export function getBoard(db: Database.Database, project: string, title: string): BoardWithRows | undefined {
  const board = findBoard(db, project, title)
  if (!board || board.status !== 'active') return undefined
  const rows = withUnseen(
    db.prepare(`SELECT ${ROW_COLUMNS} FROM board_rows WHERE board_id = ? ORDER BY position ASC`).all(board.id) as BoardRowRecord[],
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
//
// #32 × #30: a project the human CLOSED is retired from the poller too — it kept
// spawning a `gh` subprocess every 60s and kept eating the shared per-tick budget,
// diluting the refresh rate for projects still in use. Its cached chips survive
// untouched, so a peek still shows what it last knew. The closed set is DERIVED,
// so this asks closedProjects() rather than reading closed_at: a project that
// un-closed itself when an agent flagged in it resumes polling with no other
// change. A branch a closed project SHARES with a live one keeps being refreshed —
// the live project is still rendering that chip.
export function listLinkTargets(db: Database.Database): LinkTarget[] {
  const rows = db
    .prepare(
      `SELECT project, repo, stream AS branch FROM items  WHERE status = 'open'   AND repo IS NOT NULL AND repo <> '' AND stream <> ''
       UNION
       SELECT project, repo, stream AS branch FROM boards WHERE status = 'active' AND repo IS NOT NULL AND repo <> '' AND stream <> ''
       ORDER BY repo ASC, branch ASC`,
    )
    .all() as Array<LinkTarget & { project: string }>
  const closed = new Set(closedProjects(db))
  // the UNION dedupes on (project, repo, branch); (repo, branch) is the cache key,
  // so the collapse to one target per pair happens here instead
  const seen = new Set<string>()
  const targets: LinkTarget[] = []
  for (const row of rows) {
    if (closed.has(row.project)) continue
    const key = `${row.repo}\u0000${row.branch}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ repo: row.repo, branch: row.branch })
  }
  return targets.slice(0, MAX_LINK_TARGETS)
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
// being closed as soon as new CONTENT is created in it STRICTLY AFTER the close.
//
// Strictly after, and the millisecond boundary is deliberate. Both stamps are
// millisecond-resolution, so a close and a write can genuinely tie, and a tie
// resolves in favour of the human's explicit act. `>=` is the worse trade in both
// directions: closing a project in the same millisecond an item lands — the
// ordinary flow, since you close a project *because* something just finished in
// it — would leave it open, so the × click visibly does nothing and does nothing
// again on every retry while an agent keeps writing. `>` costs one missed
// un-close in a genuine tie, and the next write in any later millisecond undoes
// it by itself. (Contrast sweepStale's deliberately INCLUSIVE `>=`, whose
// inclusivity exists so MAX_AGE_MS=0 can mean "clear every backstop".)
// test/store.test.ts pins the boundary in both directions on a frozen clock.
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
