import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { ServerSource } from './server-source.js'

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
  annotated_at: string | null
  annotation_seen_at: string | null
  annotation_seen_by: string | null
  options: QuestionOption[] | null
  reply: string | null
  reply_context: string | null
  replied_at: string | null
  reply_seen_at: string | null
  reply_source: ReplySource | null
  reply_kind: ResponseKind | null
  response_revision: number
  snoozed_until: string | null
  // issue #247 — the human's "Pin for later": set aside with no return time.
  // Human-owned and NOT content (see pinItem); a trigger clears it when the ask ends.
  pinned_at: string | null
  // issue #217 — the human's "I'll take a while" for a Copilot answer watcher:
  // stopped for good (`watch_stopped_until` NULL) or until a time. Human-owned
  // and NOT content: writing it moves neither updated_at nor response_revision.
  watch_stopped_at: string | null
  watch_stopped_until: string | null
  // issue #217 — who raised this ask, recorded only by writers that know the
  // watch stop. NULL on items an older server raised: its watcher ignores a stop.
  action_agent: string | null
  outcome: string
  outcome_at: string | null
  // issue #30 — the source-link identity inferred locally at write time:
  // `owner/name` for a github.com remote, and the issue number the BRANCH names.
  // Both null whenever the answer was not unambiguous, and null on every row
  // written before #30 (the additive migration backfills nothing — deliberately;
  // there is no way to know what a historical item's remote was).
  repo: string | null
  issue_ref: number | null
  // issue #157 — the `owner/name` this item's branch is PUSHED to, where its PR
  // must come from (`repo` is the base the PR is opened against). NULL when none
  // was inferred and on every row written before #157: a same-repository PR.
  // Issue #183: a `gh pr checkout` branch that tracks a pull request's ref and
  // pushes back where it fetches from records that ref (`refs/pull/<n>/head`)
  // instead, which no PR can verify against.
  head_repo: string | null
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
  head_repo?: string | null
}

export function defaultDbPath(): string {
  return process.env.AGENT_INBOX_DB ?? join(homedir(), '.agent-inbox', 'inbox.db')
}

export function openDb(path: string = defaultDbPath()): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  // Every process shares this file through WAL + busy_timeout, but SQLite never
  // waits when a deferred reader is promoted to the writer, so any transaction
  // whose first statement reads and that may later write must be `.immediate()`.
  db.pragma('busy_timeout = 5000')
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}

export interface SnapshotReadState {
  dataVersion: number
  totalChanges: number
  schemaVersion: number
  inTransaction: boolean
}

export function readSnapshotState(db: Database.Database): SnapshotReadState {
  // data_version observes other connections; total_changes observes this one's
  // row writes, and schema_version also catches its DDL/read failures.
  // Transactional reads cannot be cached: a rollback does not undo total_changes.
  const state = db.prepare(`SELECT data_version AS dataVersion, total_changes() AS totalChanges,
      schema_version AS schemaVersion
    FROM pragma_data_version, pragma_schema_version`).get() as Omit<SnapshotReadState, 'inTransaction'>
  return { ...state, inTransaction: db.inTransaction }
}

function migrate(db: Database.Database): void {
  // Reserve the WAL writer before any migration reads. A deferred transaction
  // cannot wait when a stale read snapshot is promoted to a writer.
  db.transaction(() => runMigrations(db)).immediate()
}

function runMigrations(db: Database.Database): void {
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
      annotated_at TEXT,
      annotation_seen_at TEXT,
      annotation_seen_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      reply_kind TEXT,
      response_revision INTEGER NOT NULL DEFAULT 0,
      snoozed_until TEXT,
      outcome TEXT NOT NULL DEFAULT '',
      outcome_at TEXT,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_items_status_project ON items(status, project);
    CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
    CREATE TABLE IF NOT EXISTS item_reply_intents (
      item_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      applied INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_id, client_id, action_id)
    );
    CREATE INDEX IF NOT EXISTS idx_item_reply_intents_high_water
      ON item_reply_intents(item_id, client_id, sequence);
    CREATE TRIGGER IF NOT EXISTS delete_item_reply_intents
      AFTER DELETE ON items
      BEGIN
        DELETE FROM item_reply_intents WHERE item_id = OLD.id;
      END;
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
    CREATE TABLE IF NOT EXISTS activity_spans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session TEXT NOT NULL,
      project TEXT NOT NULL,
      stream TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT 'unknown',
      doing TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_spans_open ON activity_spans(session) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_activity_spans_project_started ON activity_spans(project, started_at);
    -- listActivitySpans' since overlap: a range over closed ends plus the
    -- open (NULL) group. Deliberately not last_active_at, which every call bumps.
    CREATE INDEX IF NOT EXISTS idx_activity_spans_ended ON activity_spans(ended_at);
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
      pr_head_sha TEXT,
      pr_draft INTEGER,
      review_decision TEXT,
      checks TEXT,
      issue_number INTEGER,
      issue_url TEXT,
      issue_title TEXT,
      preview_url TEXT,
      preview_environment TEXT,
      preview_deployment_id INTEGER,
      preview_updated_at TEXT,
      preview_error TEXT,
      tldr TEXT,
      fetched_at TEXT,
      checked_at TEXT NOT NULL,
      error TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (repo, branch)
    );
    CREATE TABLE IF NOT EXISTS source_links_by_head (
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_repo TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'github',
      pr_number INTEGER,
      pr_url TEXT,
      pr_title TEXT,
      pr_state TEXT,
      pr_head_sha TEXT,
      pr_draft INTEGER,
      review_decision TEXT,
      checks TEXT,
      issue_number INTEGER,
      issue_url TEXT,
      issue_title TEXT,
      preview_url TEXT,
      preview_environment TEXT,
      preview_deployment_id INTEGER,
      preview_updated_at TEXT,
      preview_error TEXT,
      tldr TEXT,
      fetched_at TEXT,
      checked_at TEXT NOT NULL,
      error TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (repo, branch, head_repo)
    );
    CREATE TABLE IF NOT EXISTS issue_snapshots (
      repo TEXT NOT NULL COLLATE NOCASE,
      number INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'github',
      snapshot TEXT,
      fetched_at TEXT,
      checked_at TEXT NOT NULL,
      error TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (repo, number)
    );
    CREATE TABLE IF NOT EXISTS issue_refresh_claims (
      repo TEXT NOT NULL COLLATE NOCASE,
      number INTEGER NOT NULL,
      owner TEXT NOT NULL,
      lease_until TEXT NOT NULL,
      PRIMARY KEY (repo, number)
    );
    CREATE TABLE IF NOT EXISTS hook_watch_claims (
      claim_key TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      claimed_at TEXT NOT NULL
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
  // issue #197 — the Agent Inbox build the session's MCP server runs, and
  // whether it runs from an installed agent runtime or a checkout, written by
  // that server's own presence and status writes. NULL on legacy rows and on
  // rows written by older servers: Live then shows nothing rather than a guess.
  // Display only, never a liveness or work signal.
  ensureColumn(db, 'activity', 'server_version', 'TEXT')
  ensureColumn(db, 'activity', 'server_source', 'TEXT')
  // issue #253 — the process that started this session's MCP server (Claude
  // Code, for a stdio server it spawned) and the server's own pid. A Claude
  // Code hook is a child of that same process, so its parent pid finds the
  // servers of its own session. NULL on legacy rows and on rows older servers
  // write: no hook links to them, and the hook watches the cwd project alone.
  ensureColumn(db, 'activity', 'host_pid', 'INTEGER')
  ensureColumn(db, 'activity', 'server_pid', 'INTEGER')
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
  // issue #157 — the head repository the branch is pushed to. NULL on every
  // legacy row: it then expects a same-repository PR (see listLinkTargets).
  ensureColumn(db, 'items', 'head_repo', 'TEXT')
  migrateReplyIntentLedger(db)
  ensureColumn(db, 'boards', 'repo', 'TEXT')
  ensureColumn(db, 'boards', 'issue_ref', 'INTEGER')
  ensureColumn(db, 'boards', 'head_repo', 'TEXT')
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
  ensureColumn(db, 'source_links', 'pr_head_sha', 'TEXT')
  ensureColumn(db, 'source_links', 'preview_url', 'TEXT')
  ensureColumn(db, 'source_links', 'preview_environment', 'TEXT')
  ensureColumn(db, 'source_links', 'preview_deployment_id', 'INTEGER')
  ensureColumn(db, 'source_links', 'preview_updated_at', 'TEXT')
  ensureColumn(db, 'source_links', 'preview_error', 'TEXT')
  ensureColumn(db, 'source_links', 'revision', 'INTEGER NOT NULL DEFAULT 1')
  // issue #103 PR1b — every issue the cached PR closes, as JSON bound to the
  // fetched_at it was written with (see upsertSourceLink). NULL on legacy rows.
  ensureColumn(db, 'source_links_by_head', 'closing_refs', 'TEXT')
  // issue #217 — the human's stop for a Copilot answer watcher. Plain additive
  // columns: NULL means nobody asked the watcher to stop, so nothing to backfill.
  ensureColumn(db, 'items', 'watch_stopped_at', 'TEXT')
  ensureColumn(db, 'items', 'watch_stopped_until', 'TEXT')
  ensureColumn(db, 'board_rows', 'watch_stopped_at', 'TEXT')
  ensureColumn(db, 'board_rows', 'watch_stopped_until', 'TEXT')
  migrateRowActionWatchState(db)
  migrateActionLifecycle(db)
  migrateItemResponseRevision(db)
  migrateItemAnnotationDelivery(db)
  migrateAnnotationDelivery(db)
  // issue #103 PR2 — an explicit plan pin and row link, agent-owned. Plain
  // additive columns: no statement an older process runs names them, so its
  // writes keep them (test/mixed-version.test.ts), and nothing is backfilled.
  ensureColumn(db, 'boards', 'issue_pin_repo', 'TEXT')
  ensureColumn(db, 'boards', 'issue_pin_number', 'INTEGER')
  ensureColumn(db, 'board_rows', 'issue_repo', 'TEXT')
  ensureColumn(db, 'board_rows', 'issue_number', 'INTEGER')
  // issue #103 slice 2 — GitHub's issue dependencies, as JSON bound to the
  // fetched_at written beside them (see upsertIssueSnapshot). NULL on legacy
  // rows and after an older viewer's write: "unknown", never "no dependencies".
  ensureColumn(db, 'issue_snapshots', 'dependencies', 'TEXT')
  migratePinForLater(db)
  // issue #103 slice 2 (§4.3) — a row's agent-declared step dependencies, a
  // sorted JSON array of other rows' labels (NULL = none). Additive like PR2's
  // link columns: no statement an older process runs names it, so its writes
  // keep it (test/mixed-version.test.ts), and nothing is backfilled.
  ensureColumn(db, 'board_rows', 'waits_on', 'TEXT')
}

// Issue #247 — the human's "Pin for later". NULL means not pinned, so there is
// nothing to backfill. The resets are triggers, not writer code, so the writes
// of an older server sharing the file, which know nothing of pins, still end a
// pin when the ask ends or a new action starts (reset_row_action_watch_state's
// precedent). Each inner UPDATE names only pinned_at, which no trigger listens
// to, so neither can fire again, and neither moves updated_at or a revision.
function migratePinForLater(db: Database.Database): void {
  ensureColumn(db, 'items', 'pinned_at', 'TEXT')
  ensureColumn(db, 'board_rows', 'pinned_at', 'TEXT')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS clear_row_pin_when_ask_ends
    AFTER UPDATE OF action_version, status, annotation, annotation_kind, handled_at ON board_rows
    WHEN NEW.pinned_at IS NOT NULL AND (
          NEW.action_version IS NOT OLD.action_version
       OR NEW.status IS NOT 'blocked'
       OR COALESCE(NEW.annotation, '') <> ''
       OR NEW.annotation_kind IS NOT NULL
       OR NEW.handled_at IS NOT NULL)
    BEGIN
      UPDATE board_rows SET pinned_at = NULL WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS clear_item_pin_when_ask_ends
    AFTER UPDATE OF status, reply, reply_kind ON items
    WHEN NEW.pinned_at IS NOT NULL AND (
          NEW.status IS NOT 'open'
       OR COALESCE(NEW.reply, '') <> ''
       OR NEW.reply_kind IS NOT NULL)
    BEGIN
      UPDATE items SET pinned_at = NULL WHERE id = NEW.id;
    END;
  `)
}

// Issue #217 — who raised the current ask, and the human's stop for it, belong
// to ONE action. Older servers sharing the file start new actions without
// knowing either column, so a trigger, not the writer, resets them whenever
// action_version moves: the stop never carries over, and the asker survives
// only when the same statement stamped it for the new version. No backfill:
// an unknown asker hides the stop control rather than guessing.
function migrateRowActionWatchState(db: Database.Database): void {
  ensureColumn(db, 'items', 'action_agent', 'TEXT')
  ensureColumn(db, 'board_rows', 'action_agent', 'TEXT')
  ensureColumn(db, 'board_rows', 'action_agent_version', 'INTEGER')
  db.exec(`CREATE TRIGGER IF NOT EXISTS reset_row_action_watch_state
    AFTER UPDATE OF action_version ON board_rows
    WHEN NEW.action_version IS NOT OLD.action_version
    BEGIN
      UPDATE board_rows
         SET watch_stopped_at = NULL,
             watch_stopped_until = NULL,
             action_agent = CASE WHEN NEW.action_agent_version IS NEW.action_version THEN NEW.action_agent END,
             action_agent_version = CASE WHEN NEW.action_agent_version IS NEW.action_version THEN NEW.action_version END
       WHERE id = NEW.id;
    END`)
}

function migrateItemResponseRevision(db: Database.Database): void {
  if (!hasColumn(db, 'items', 'response_revision')) {
    db.exec(`ALTER TABLE items ADD COLUMN response_revision INTEGER NOT NULL DEFAULT 0`)
    db.exec(`UPDATE items SET response_revision = 1
      WHERE replied_at IS NOT NULL OR COALESCE(reply, '') <> '' OR COALESCE(annotation, '') <> ''`)
  }
  // A trigger also versions writes from an older viewer sharing this database.
  // Delivery stamps do not participate, and repeated same-millisecond replies do.
  db.exec(`CREATE TRIGGER IF NOT EXISTS increment_item_response_revision
    AFTER UPDATE OF reply, reply_context, reply_kind, reply_source, replied_at, annotation ON items
    BEGIN
      UPDATE items SET response_revision = OLD.response_revision + 1 WHERE id = NEW.id;
    END`)
}

function migrateItemAnnotationDelivery(db: Database.Database): void {
  const introduced = !hasColumn(db, 'items', 'annotation_seen_at')
  ensureColumn(db, 'items', 'annotated_at', 'TEXT')
  ensureColumn(db, 'items', 'annotation_seen_at', 'TEXT')
  ensureColumn(db, 'items', 'annotation_seen_by', 'TEXT')
  if (introduced) {
    // Legacy text has no trustworthy edit or pickup time. Only its existence
    // establishes response history; leave both timestamps unknown.
    db.exec(`UPDATE items SET response_revision = 1
      WHERE response_revision = 0 AND COALESCE(annotation, '') <> ''`)
  }
  // Older viewers write annotation + updated_at but know nothing of receipts.
  // Reset delivery in their write too, including same-millisecond replacements.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS reset_item_annotation_delivery
    AFTER UPDATE OF annotation ON items
    BEGIN
      UPDATE items
         SET annotated_at = NEW.updated_at, annotation_seen_at = NULL, annotation_seen_by = NULL
       WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS refuse_closed_item_annotations
    BEFORE UPDATE OF annotation ON items
    WHEN OLD.status <> 'open'
    BEGIN
      SELECT RAISE(IGNORE);
    END;
  `)
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

function migrateReplyIntentLedger(db: Database.Database): void {
  if (
    !hasColumn(db, 'items', 'reply_intent_client')
    || !hasColumn(db, 'items', 'reply_intent_sequence')
  ) return
  db.exec(`
    INSERT INTO item_reply_intents
      (item_id, client_id, action_id, sequence, applied, created_at)
    SELECT id,
           reply_intent_client,
           '__legacy_watermark__',
           reply_intent_sequence,
           1,
           created_at
      FROM items
     WHERE reply_intent_client IS NOT NULL
       AND reply_intent_client <> ''
       AND reply_intent_sequence IS NOT NULL
       AND reply_intent_sequence >= 1
    ON CONFLICT(item_id, client_id, action_id) DO UPDATE
      SET sequence = MAX(sequence, excluded.sequence)
  `)
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
  // (agent retries, re-runs) must not stack duplicates. The lookup and the INSERT
  // share one IMMEDIATE transaction, so another process cannot announce the same
  // milestone between them; a duplicate gets the id that already exists.
  if (item.kind === 'done') {
    return db.transaction((): string => {
      const existing = db
        .prepare(`SELECT id FROM items WHERE kind = 'done' AND status = 'open' AND project = ? AND title = ?`)
        .get(item.project, item.title) as { id: string } | undefined
      return existing ? existing.id : insertItemRow(db, item)
    }).immediate()
  }
  return insertItemRow(db, item)
}

function insertItemRow(db: Database.Database, item: NewItem): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO items (
       id, project, stream, agent, action_agent, session, kind, title, detail, next_step,
       action_owner, impact, next_after, context, options, repo, issue_ref, head_repo,
       status, created_at, updated_at)
     VALUES (
       @id, @project, @stream, @agent, @agent, @session, @kind, @title, @detail, @next_step,
       @action_owner, @impact, @next_after, @context, @options, @repo, @issue_ref, @head_repo,
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
    head_repo: item.head_repo ?? null,
    created_at: now,
    updated_at: now,
  })
  return id
}

// The question's answer, whoever wrote it: what a client compares with the
// response it sent (#322).
export type ReplyAnswer = Pick<Item, 'replied_at' | 'reply_source' | 'reply_kind' | 'reply' | 'reply_context'>

// What one reply request did. `ok` is false when the write was refused, so a
// caller (the viewer's POST handler) can surface a refusal instead of a silent
// no-op; true when this request wrote, or repeats an intent the store already
// applied. Issue #322: that replay is answered from the intent's record and
// writes nothing, so `ok` alone cannot say whether the sent text is still the
// answer. `wrote` says whether THIS request changed the question, `replayed`
// that the store already held its intent (applied or refused), and `answer`
// is the question's answer once the request was done (null for no question).
// For an intent the answer is read in the same transaction as the decision;
// without one it is read just after the write, which nothing can undo, so a
// concurrent writer can only make it newer.
export interface ReplyResult {
  ok: boolean
  wrote: boolean
  replayed: boolean
  answer: ReplyAnswer | null
  // #321: refused because the open question no longer holds the expected answer
  reason?: 'answer_changed'
}

// Issue #321: the answer a page means to replace, the one it last showed. A
// reply that carries it is written only while the question still holds it, in
// the same conditioned statement, so a newer answer the page never showed (from
// another window, or an agent's chat answer) refuses the write instead of being
// replaced unseen. Without it a reply stays unconditional, as it always was.
export type ExpectedAnswer = Pick<Item, 'replied_at' | 'reply_source' | 'reply_kind' | 'reply'>

const EXPECTED_ANSWER_SQL = `(@expect = 0
  OR (replied_at IS @expectedAt AND reply_source IS @expectedSource
      AND reply_kind IS @expectedKind AND reply IS @expectedReply))`

export function replyItem(
  db: Database.Database,
  id: string,
  text: string,
  context?: string,
  kind: ResponseKind = 'answer',
  intent?: { clientId: string; sequence: number; actionId: string },
  expected?: ExpectedAnswer,
): ReplyResult {
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
  const params = {
    id,
    reply,
    replyContext: replyContext || null,
    kind,
    now,
    expect: expected ? 1 : 0,
    expectedAt: expected?.replied_at ?? null,
    expectedSource: expected?.reply_source ?? null,
    expectedKind: expected?.reply_kind ?? null,
    expectedReply: expected?.reply ?? null,
  }
  const applyReply = (): boolean => {
    if (!reply) {
    // atomic: the guard condition (reply_seen_at IS NULL) is checked and acted on in the
    // SAME statement as the write, so a concurrent markReplySeen from another connection
    // (e.g. the MCP server's `pending` handler, its own OS process) can never land in a
    // window between a read and a later, unconditional write — there is no such window.
      const info = db
        .prepare(`UPDATE items
                     SET reply = NULL, reply_context = NULL, replied_at = @now, reply_seen_at = NULL,
                         reply_source = NULL, reply_kind = NULL, updated_at = @now
                   WHERE id = @id AND kind = 'question' AND status = 'open'
                     AND reply_seen_at IS NULL AND ${EXPECTED_ANSWER_SQL}`)
        .run(params)
      return info.changes > 0
    }
    // Inbox replies remain higher precedence than agent-recorded chat answers.
    const info = db.prepare(`UPDATE items
                   SET reply = @reply, reply_context = @replyContext, replied_at = @now, reply_seen_at = NULL,
                       reply_source = 'inbox', reply_kind = @kind,
                       snoozed_until = NULL, pinned_at = NULL, updated_at = @now
                 WHERE id = @id AND kind = 'question' AND status = 'open'
                   AND ${EXPECTED_ANSWER_SQL}`)
      .run(params)
    return info.changes > 0
  }
  const currentAnswer = (): ReplyAnswer | null => (db.prepare(`
      SELECT replied_at, reply_source, reply_kind, reply, reply_context
        FROM items
       WHERE id = ? AND kind = 'question'`)
    .get(id) as ReplyAnswer | undefined) ?? null

  // Read after a refused write, never to decide one: the open question's
  // answer is not the expected one, so the expectation refused it (#321).
  const changed = (answer: ReplyAnswer | null): Pick<ReplyResult, 'reason'> =>
    expected && answer && (answer.replied_at !== expected.replied_at || answer.reply_source !== expected.reply_source
      || answer.reply_kind !== expected.reply_kind || answer.reply !== expected.reply)
      ? { reason: 'answer_changed' }
      : {}
  const openQuestion = () => db.prepare(`SELECT id FROM items WHERE id = ? AND kind = 'question' AND status = 'open'`).get(id)

  if (!intent) {
    const wrote = applyReply()
    const answer = currentAnswer()
    return { ok: wrote, wrote, replayed: false, answer, ...(!wrote && openQuestion() ? changed(answer) : {}) }
  }
  return db.transaction((): ReplyResult => {
    if (!openQuestion()) return { ok: false, wrote: false, replayed: false, answer: currentAnswer() }
    const recorded = db.prepare(`
      SELECT applied
        FROM item_reply_intents
       WHERE item_id = ? AND client_id = ? AND action_id = ?`)
      .get(id, intent.clientId, intent.actionId) as { applied: number } | undefined
    if (recorded) return { ok: recorded.applied === 1, wrote: false, replayed: true, answer: currentAnswer() }

    const waterMark = db.prepare(`
      SELECT MAX(sequence) AS sequence
        FROM item_reply_intents
       WHERE item_id = ? AND client_id = ?`)
      .get(id, intent.clientId) as { sequence: number | null }
    const superseded = waterMark.sequence !== null && intent.sequence < waterMark.sequence
    const applied = superseded ? false : applyReply()
    db.prepare(`
      INSERT INTO item_reply_intents
        (item_id, client_id, action_id, sequence, applied, created_at)
      SELECT @id, @clientId, @actionId, @sequence, @applied, @now
       WHERE EXISTS (SELECT 1 FROM items WHERE id = @id)`)
      .run({
        id,
        clientId: intent.clientId,
        actionId: intent.actionId,
        sequence: intent.sequence,
        applied: applied ? 1 : 0,
        now,
      })
    const answer = currentAnswer()
    return { ok: applied, wrote: applied, replayed: false, answer, ...(applied || superseded ? {} : changed(answer)) }
  }).immediate()
}

// True means this snapshot is still current, not that this reader was first.
// MCP supplies the monotonic revision: timestamps alone cannot distinguish
// corrections made in the same millisecond. COALESCE preserves the first receipt.
// Full-question delivery opts into stamping both response halves atomically.
export function markReplySeen(
  db: Database.Database,
  id: string,
  repliedAt: string | null,
  expectedResponseRevision?: number,
  annotationReader?: string | null,
): boolean {
  const info = db
    .prepare(`UPDATE items SET reply_seen_at =
                CASE WHEN COALESCE(reply, '') <> '' THEN COALESCE(reply_seen_at, @now) ELSE reply_seen_at END,
              annotation_seen_at =
                CASE WHEN @annotations = 1 AND (annotated_at IS NOT NULL OR COALESCE(annotation, '') <> '')
                     THEN COALESCE(annotation_seen_at, @now) ELSE annotation_seen_at END,
              annotation_seen_by =
                CASE WHEN @annotations = 1 AND (annotated_at IS NOT NULL OR COALESCE(annotation, '') <> '')
                     THEN COALESCE(annotation_seen_by, @by) ELSE annotation_seen_by END
              WHERE id = @id AND kind = 'question' AND status = 'open'
                AND replied_at IS @repliedAt
                AND (@revision IS NULL OR response_revision = @revision)`)
    .run({
      id, repliedAt, revision: expectedResponseRevision ?? null, now: new Date().toISOString(),
      annotations: annotationReader === undefined ? 0 : 1, by: annotationReader ?? null,
    })
  return info.changes > 0
}

export function markItemAnnotationDelivered(
  db: Database.Database,
  id: string,
  expectedResponseRevision: number,
  by: string | null,
): boolean {
  const info = db.prepare(`UPDATE items SET annotation_seen_at =
                  CASE WHEN annotated_at IS NOT NULL OR COALESCE(annotation, '') <> ''
                       THEN COALESCE(annotation_seen_at, @now) ELSE annotation_seen_at END,
                annotation_seen_by =
                  CASE WHEN annotated_at IS NOT NULL OR COALESCE(annotation, '') <> ''
                       THEN COALESCE(annotation_seen_by, @by) ELSE annotation_seen_by END
              WHERE id = @id AND status = 'open' AND response_revision = @revision`)
    .run({ id, revision: expectedResponseRevision, by, now: new Date().toISOString() })
  return info.changes > 0
}

export type AnswerRefusal = 'empty' | 'not_found' | 'not_a_question' | 'not_open' | 'unread_inbox_answer'

export interface AnswerResult {
  ok: boolean
  reason?: AnswerRefusal
  response_revision?: number
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
  const written = db
    .prepare(
      `UPDATE items
          SET reply = ?, reply_context = ?, replied_at = ?, reply_seen_at = ?,
              reply_source = 'agent', reply_kind = ?, snoozed_until = NULL, updated_at = ?
       WHERE id = ? AND kind = 'question' AND status = 'open'
         AND (reply IS NULL OR reply = '' OR reply_seen_at IS NOT NULL)
       RETURNING response_revision + 1 AS response_revision`,
    )
    .get(reply, context?.trim() || null, now, now, kind, now, id) as { response_revision: number } | undefined
  // RETURNING sees the row before the response-revision AFTER trigger runs.
  if (written) return { ok: true, response_revision: written.response_revision }
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

export function listPending(
  db: Database.Database,
  project: string,
  opts: { includeInformational?: boolean; itemId?: string } = {},
): Item[] {
  // Hooks/backstops retain their question-only default. MCP explicitly opts in
  // to informational feedback, with a targeted recovery path after pickup.
  const rows = db
    .prepare(`SELECT * FROM items
      WHERE status = 'open' AND project = @project
        AND ((@itemId IS NOT NULL AND id = @itemId)
             OR (@itemId IS NULL AND (
               kind = 'question'
               OR (@informational = 1 AND kind IN ('note', 'done')
                   AND annotation_seen_at IS NULL
                   AND (annotated_at IS NOT NULL OR COALESCE(annotation, '') <> '')))))
      ORDER BY created_at ASC`)
    .all({ project, itemId: opts.itemId ?? null, informational: opts.includeInformational ? 1 : 0 })
  return (rows as Array<Omit<Item, 'options'> & { options: string | null }>).map(parseItem)
}

type StoredItem = Omit<Item, 'options'> & {
  options: string | null
  reply_intent_client?: string | null
  reply_intent_sequence?: number | null
}

function parseItem(row: StoredItem): Item {
  const visible = { ...row }
  delete visible.reply_intent_client
  delete visible.reply_intent_sequence
  return { ...visible, options: parseOptions(row.options) }
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

export type ResolveResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_open' | 'response_revision_required' | 'response_changed' }

// Viewer/hook closures remain explicit. MCP always supplies a guard, even when
// its caller omitted the revision; no shared-process read can authorize a sibling.
export function resolveItem(
  db: Database.Database,
  id: string,
  outcome?: string,
  responseGuard?: { expectedRevision?: number },
): ResolveResult {
  const now = new Date().toISOString()
  const text = outcome?.trim() ?? ''
  const info = db.prepare(`UPDATE items
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
               WHERE id = @id
                 AND (@guarded = 0 OR status IN ('open', 'resolved'))
                 AND (@guarded = 0
                      OR response_revision = @expected
                      OR (@expected IS NULL AND response_revision = 0))`)
    .run({
      now, text, id,
      guarded: responseGuard === undefined ? 0 : 1,
      expected: responseGuard?.expectedRevision ?? null,
    })
  if (info.changes > 0) return { ok: true }
  const current = getItem(db, id)
  if (!current) return { ok: false, reason: 'not_found' }
  if (current.status === 'dismissed') return { ok: false, reason: 'not_open' }
  if (responseGuard?.expectedRevision === undefined) {
    return { ok: false, reason: 'response_revision_required' }
  }
  return { ok: false, reason: 'response_changed' }
}

export function dismissItem(db: Database.Database, id: string): void {
  db.prepare(`UPDATE items SET status = 'dismissed', updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id)
}

export function annotateItem(db: Database.Database, id: string, text: string): boolean {
  const info = db.prepare(`UPDATE items SET annotation = ?, updated_at = ? WHERE id = ? AND status = 'open'`)
    .run(text, new Date().toISOString(), id)
  return info.changes > 0
}

// A snooze with a time replaces a pin (#247); waking (null) leaves one alone.
export function snoozeItem(db: Database.Database, id: string, until: string | null): boolean {
  const info = db.prepare(`UPDATE items SET snoozed_until = @until,
                              pinned_at = CASE WHEN @until IS NOT NULL THEN NULL ELSE pinned_at END,
                              updated_at = @now
                            WHERE id = @id AND status = 'open'`)
    .run({ id, until, now: new Date().toISOString() })
  return info.changes > 0
}

// Issue #247 §5.4 — "I'll take a while" with the Later section on: the watch
// stop and the inbox deferral (a pin for `until` null, a snooze to `until`
// otherwise) land together or not at all.
interface StopWatchOptions {
  defer?: boolean
}

// A refused half is not an error, so it rolls the transaction back through this
// sentinel rather than an exception the caller would have to tell apart.
const DEFER_REFUSED = Symbol('defer refused')

// ONE IMMEDIATE transaction: the write lock is held from its BEGIN, so no other
// process can land between the halves. Each half is the existing conditioned
// write, pinned to the same revisions; the stop moves no revision, so the
// deferral checks exactly what the stop checked. Any refusal or error undoes
// both.
function stopAndDefer(db: Database.Database, stop: () => boolean, defer: () => boolean): boolean {
  const run = db.transaction((): true => {
    if (!stop() || !defer()) throw DEFER_REFUSED
    return true
  })
  try {
    return run.immediate()
  } catch (err) {
    if (err === DEFER_REFUSED) return false
    throw err
  }
}

// Issue #217 — the human tells the asking Copilot session to stop waiting on
// this question: for good (`until` null) or until a time. One conditioned
// statement, refused on an answered or closed question, and on a stop for
// good, which has already ended the watcher and therefore cannot be revised
// into a deferral that nothing would honour. An item is its own ask, so there
// is no newer action to pin against. Not content: updated_at stays put.
// `defer` (#247) also pins the question (stop for good) or snoozes it to the
// same time, exactly as pinItem or snoozeItem would, in the same transaction.
export function stopItemWatch(
  db: Database.Database,
  id: string,
  until: string | null,
  { defer = false }: StopWatchOptions = {},
): boolean {
  const stop = (): boolean => db.prepare(`UPDATE items SET watch_stopped_at = @now, watch_stopped_until = @until
                            WHERE id = @id AND kind = 'question' AND status = 'open'
                              AND COALESCE(reply, '') = ''
                              AND (watch_stopped_at IS NULL OR watch_stopped_until IS NOT NULL)`)
    .run({ id, until, now: new Date().toISOString() }).changes > 0
  if (!defer) return stop()
  return stopAndDefer(db, stop, () => (until === null ? pinItem(db, id, true) : snoozeItem(db, id, until)))
}

// Issue #247 — "Pin for later": the human sets an unanswered question aside
// with no return time, or (pinned false) brings it back. One conditioned
// statement each way. A re-pin keeps the first time, and a pin replaces a
// snooze. Not content, like the #217 watch stop: updated_at and the response
// revision stay put. An answer or a closure clears it through
// clear_item_pin_when_ask_ends, whichever server writes it.
export function pinItem(db: Database.Database, id: string, pinned: boolean): boolean {
  const info = pinned
    ? db.prepare(`UPDATE items SET pinned_at = COALESCE(pinned_at, @now), snoozed_until = NULL
                   WHERE id = @id AND kind = 'question' AND status = 'open'
                     AND COALESCE(reply, '') = '' AND reply_kind IS NULL`)
      .run({ id, now: new Date().toISOString() })
    : db.prepare(`UPDATE items SET pinned_at = NULL WHERE id = @id AND pinned_at IS NOT NULL`).run({ id })
  return info.changes > 0
}

export function listItems(db: Database.Database, opts: { status?: Status } = {}): Item[] {
  const rows = opts.status
    ? db.prepare(`SELECT * FROM items WHERE status = ? ORDER BY created_at DESC`).all(opts.status)
    : db.prepare(`SELECT * FROM items ORDER BY created_at DESC`).all()
  return (rows as Array<Omit<Item, 'options'> & { options: string | null }>).map(parseItem)
}

// Issue #156: only the open questions, for the Electron dock watcher's 3-second
// poll, so its read never materializes or serializes closed history and notes.
// listItems(db) is served by a backwards walk of idx_items_created, which orders
// same-millisecond ties by descending rowid; this filtered read sorts in a temp
// b-tree instead, so it names that tiebreaker and keeps the watcher's results
// identical to the full read's (test/reply-watch.test.ts).
export function listOpenQuestions(db: Database.Database): Item[] {
  const rows = db.prepare(`SELECT * FROM items WHERE status = 'open' AND kind = 'question'
    ORDER BY created_at DESC, rowid DESC`).all()
  return (rows as StoredItem[]).map(parseItem)
}

// Issue #184: the viewer's default item snapshot used to carry every closed item
// ever, re-sent in full whenever any item changed. A page carries every open
// item plus the `closedLimit` most recently TOUCHED closed items; `history`
// summarizes the rest so counts stay exact without them.
export interface ClosedHistoryGroup {
  project: string
  agent: string
  /** omitted closed items for this project and agent */
  items: number
  /** how many of them record an outcome */
  outcomes: number
  /** the newest Dashboard stamp (public/relay.js `stamp`) among those outcomes;
   *  null when none of the omitted items records one */
  latest: string | null
}

export interface ClosedHistorySummary {
  /** every closed (resolved or dismissed) item */
  total: number
  /** closed items the page carries */
  loaded: number
  /** No omitted item was touched after this instant (null: nothing omitted). A
   *  touch is the newest of the item's stamps, so it is never before the item's
   *  creation: whatever the page carries created after it is a complete,
   *  correctly ordered History prefix. */
  before: string | null
  older: ClosedHistoryGroup[]
}

export interface ItemsPage {
  items: Item[]
  history: ClosedHistorySummary
}

// Canonical ISO strings order chronologically as text; '' stands in for NULL
// because multi-argument max() is NULL when any argument is.
const CLOSED_TOUCHED_AT = `MAX(created_at, IFNULL(updated_at, ''), IFNULL(resolved_at, ''),
  IFNULL(outcome_at, ''), IFNULL(replied_at, ''), IFNULL(reply_seen_at, ''),
  IFNULL(annotated_at, ''), IFNULL(annotation_seen_at, ''))`
// The instant public/relay.js `stamp` orders Dashboard outcomes by: the first
// of these an item has (items carry no handled stamps).
const OUTCOME_STAMP = `COALESCE(outcome_at, reply_seen_at, annotation_seen_at, replied_at,
  annotated_at, updated_at, created_at)`

// `closedLimit`: the most recently touched closed items. `outcomeLimit`: the
// newest outcome-bearing closed items of projects the human has not closed (and
// any tied with the last), which a page always carries so the Dashboard's
// default lens never depends on omitted history, however many closures without
// an outcome (Inbox resolve/dismiss, hook sweeps) have taken the recent slots.
export function listItemsPage(db: Database.Database, closedLimit: number, outcomeLimit = 0): ItemsPage {
  // Read-only, so a deferred transaction suffices: it pins one snapshot across
  // every statement, so the summary and the page can never disagree.
  return db.transaction((): ItemsPage => {
    const ranked = db.prepare(`SELECT rowid AS seq, id, project, agent, created_at,
        outcome <> '' AS has_outcome, ${CLOSED_TOUCHED_AT} AS touched_at, ${OUTCOME_STAMP} AS stamp_at
      FROM items WHERE status <> 'open'
      ORDER BY touched_at DESC, rowid DESC`).all() as Array<{
      seq: number
      id: string
      project: string
      agent: string
      created_at: string
      has_outcome: number
      touched_at: string
      stamp_at: string
    }>
    const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
    const kept = new Set(ranked.slice(0, Math.max(0, closedLimit)).map((row) => row.id))
    const closed = new Set(closedProjects(db))
    const outcomes = ranked.filter((row) => row.has_outcome && !closed.has(row.project))
      .sort((a, b) => byName(b.stamp_at, a.stamp_at) || byName(b.created_at, a.created_at) || b.seq - a.seq)
    const edge = outcomes[Math.max(0, outcomeLimit) - 1]?.stamp_at
    for (const [index, row] of outcomes.entries()) {
      if (index >= outcomeLimit && row.stamp_at !== edge) break
      kept.add(row.id)
    }
    const omitted = ranked.filter((row) => !kept.has(row.id))
    const groups = new Map<string, ClosedHistoryGroup>()
    for (const row of omitted) {
      const key = JSON.stringify([row.project, row.agent])
      const group = groups.get(key) ?? { project: row.project, agent: row.agent, items: 0, outcomes: 0, latest: null }
      group.items += 1
      if (row.has_outcome) {
        group.outcomes += 1
        if (group.latest === null || row.stamp_at > group.latest) group.latest = row.stamp_at
      }
      groups.set(key, group)
    }
    // The same created_at-then-rowid order listItems walks, so a page is an
    // order-preserving subset of the complete list.
    const rows = db.prepare(`SELECT * FROM items
      WHERE status = 'open' OR id IN (SELECT value FROM json_each(?))
      ORDER BY created_at DESC, rowid DESC`).all(JSON.stringify([...kept]))
    return {
      items: (rows as StoredItem[]).map(parseItem),
      history: {
        total: ranked.length,
        loaded: kept.size,
        before: omitted[0]?.touched_at ?? null,
        older: [...groups.values()].sort((a, b) => byName(a.project, b.project) || byName(a.agent, b.agent)),
      },
    }
  })()
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
  // issue #157 — as on items; null on every board written before #157
  head_repo: string | null
  // issue #103 PR2 — the plan's explicit issue pin, which outranks its PR and
  // branch issue (§4.2). Repository lowercased; both null when unpinned.
  issue_pin_repo: string | null
  issue_pin_number: number | null
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
  // issue #247 — the human's "Pin for later" for this ACTION (see pinBoardRow).
  // Cleared by a trigger when the ask ends or a new action starts.
  pinned_at: string | null
  // issue #217 — the human's stop for this ACTION's Copilot answer watcher (see
  // stopBoardRowWatch). Cleared only by a new action, never by a routine upsert.
  watch_stopped_at: string | null
  watch_stopped_until: string | null
  // issue #217 — the agent that raised this ACTION, stamped in the statement that
  // starts it. NULL when unknown: a legacy row, or an action an older server
  // started. Never the board's last writer, which can be another agent.
  action_agent: string | null
  // issue #103 PR2 — the row's explicit issue link, its only issue source.
  // Agent-owned row content; kept across board_advance and every status change.
  issue_repo: string | null
  issue_number: number | null
  // issue #103 slice 2 (§4) — labels of other rows of this plan that this row
  // waits on, sorted; null when none. Agent-owned like the issue link and kept
  // the same way. A label whose row was removed stays and resolves to nothing.
  waits_on: string[] | null
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

type BoardRowRecord = Omit<BoardRow, 'annotation_unseen' | 'options' | 'history' | 'waits_on'> & {
  options: string | null
  history: string | null
  waits_on: string | null
}

const ROW_COLUMNS = `
  id, label, status, note, next_step, action_owner, impact, next_after, options,
  context, annotation, annotation_kind, annotated_at, annotation_seen_at,
  annotation_seen_by, handled_at, handled_seen_at, handled_seen_by, snoozed_until,
  pinned_at, watch_stopped_at, watch_stopped_until, action_agent, issue_repo, issue_number,
  waits_on, outcome, outcome_at, created_at, updated_at, action_started_at, action_version,
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
    waits_on: parseWaitsOn(r.waits_on),
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
  /** omitted keeps the stored link; null clears it */
  issue?: IssueLink | null
  /** issue #103 slice 2: labels of other rows of this plan; omitted keeps, [] clears */
  waits_on?: string[]
}

/** An issue an agent linked explicitly; MCP normalizes every accepted form to it. */
export interface IssueLink {
  repo: string
  number: number
}

// Validated and lowercased once, here, so every writer stores one form.
function issueLinkColumns(link: IssueLink | null): { repo: string | null; number: number | null } {
  if (link === null) return { repo: null, number: null }
  if (!validIssueSlug(link.repo) || !validIssueNumber(link.number)) {
    throw new Error(`invalid issue link: ${String(link.repo)}#${String(link.number)}`)
  }
  return { repo: link.repo.toLowerCase(), number: link.number }
}

// Omission is not deletion: undefined writes nothing. Returns whether it changed.
function setRowIssueLink(db: Database.Database, rowId: string, link: IssueLink | null | undefined, now: string): boolean {
  if (link === undefined) return false
  const { repo, number } = issueLinkColumns(link)
  const info = db.prepare(`UPDATE board_rows SET issue_repo = ?, issue_number = ?, updated_at = ?
                            WHERE id = ? AND (issue_repo IS NOT ? OR issue_number IS NOT ?)`)
    .run(repo, number, now, rowId, repo, number)
  return info.changes > 0
}

function setBoardIssuePin(db: Database.Database, boardId: string, pin: IssueLink | null | undefined): boolean {
  if (pin === undefined) return false
  const { repo, number } = issueLinkColumns(pin)
  const info = db.prepare(`UPDATE boards SET issue_pin_repo = ?, issue_pin_number = ?
                            WHERE id = ? AND (issue_pin_repo IS NOT ? OR issue_pin_number IS NOT ?)`)
    .run(repo, number, boardId, repo, number)
  return info.changes > 0
}

// ── issue #103 slice 2 (§4): a row's agent-declared step dependencies ───────
//
// waits_on names other rows of the SAME plan by label, the identity agents
// already keep stable (§4.4). It is never a human blocker and never attention:
// a row that waits on another step is tracked or partial.
const WAITS_ON_LIMIT = 20

// §4.2's shape rules, checked before anything is written. Duplicates collapse
// and order means nothing, so one form is stored: sorted. [] clears.
function waitsOnLabels(label: string, value: string[]): string[] {
  if (!Array.isArray(value) || value.some((target) => typeof target !== 'string')) {
    throw new Error(`waits_on of row "${label}" must be a list of row labels`)
  }
  if (value.length > WAITS_ON_LIMIT) {
    throw new Error(`waits_on of row "${label}" names ${value.length} rows; the limit is ${WAITS_ON_LIMIT}`)
  }
  if (value.includes('')) throw new Error(`waits_on of row "${label}" contains an empty label`)
  if (value.includes(label)) throw new Error(`waits_on of row "${label}" names the row itself`)
  return [...new Set(value)].sort()
}

function waitsOnColumn(labels: string[] | undefined): string | null {
  return labels?.length ? JSON.stringify(labels) : null
}

// Validated on read as on write; anything else reads as none, never a throw.
function parseWaitsOn(raw: string | null): string[] | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value) && value.length > 0 && value.length <= WAITS_ON_LIMIT
      && value.every((target) => typeof target === 'string' && target !== '')) return value as string[]
  } catch { /* unreadable: none */ }
  return null
}

// Omission is not deletion: undefined writes nothing. Returns whether it changed.
function setRowWaitsOn(db: Database.Database, rowId: string, labels: string[] | undefined, now: string): boolean {
  if (labels === undefined) return false
  const encoded = waitsOnColumn(labels)
  const info = db.prepare(`UPDATE board_rows SET waits_on = ?, updated_at = ? WHERE id = ? AND waits_on IS NOT ?`)
    .run(encoded, now, rowId, encoded)
  return info.changes > 0
}

/** Each row of a plan by label, with the labels it waits on. */
type PlanWaits = Map<string, string[]>

// In row order, so a refusal names the same cycle every time.
function planWaitsOn(db: Database.Database, boardId: string): PlanWaits {
  const rows = db.prepare(`SELECT label, waits_on FROM board_rows WHERE board_id = ? ORDER BY position ASC`)
    .all(boardId) as Array<{ label: string; waits_on: string | null }>
  return new Map(rows.map((r) => [r.label, parseWaitsOn(r.waits_on) ?? []]))
}

// §4.2, inside the writing transaction once its rows are written, so a refusal
// rolls the whole write back. Only what this write adds is checked: a label a
// row names for the first time must be a row of the plan, and no edge the write
// adds or revives (a returning row brings back the labels naming it) may close a
// cycle. A label stored earlier whose row is gone stays and is never re-checked,
// so a row naming a removed one never refuses someone else's routine write.
// Linear in the plan's rows and edges: this runs holding the hub's write lock.
function checkWaitsOn(db: Database.Database, boardId: string, before: PlanWaits, written: Map<string, string[]>): void {
  const after = planWaitsOn(db, boardId)
  for (const [label, labels] of written) {
    const stored = new Set(before.get(label))
    for (const target of labels) {
      if (!stored.has(target) && !after.has(target)) {
        throw new Error(`waits_on of row "${label}" names "${target}", but no row of this plan is labelled "${target}"`)
      }
    }
  }
  let components: Map<string, number> | undefined
  for (const [from, labels] of after) {
    for (const to of labels) {
      const resolvedBefore = before.has(to) && Boolean(before.get(from)?.includes(to))
      if (!after.has(to) || resolvedBefore) continue
      // An edge lies on a cycle exactly when its ends share a component, so the
      // path search runs once, for the first such edge: the one the error names.
      components ??= waitsOnComponents(after)
      if (components.get(from) !== components.get(to)) continue
      const path = waitsOnPath(after, to, from)
      if (path) throw new Error(`waits_on would create a cycle: ${[from, ...path].join(' → ')}`)
    }
  }
}

// Strongly connected components over rows that exist (Tarjan), iterative so a
// long chain cannot overflow the stack. Rows sharing a number reach each other.
function waitsOnComponents(plan: PlanWaits): Map<string, number> {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const component = new Map<string, number>()
  const stack: string[] = []
  let visited = 0
  let found = 0
  const visit = (row: string): void => {
    index.set(row, visited)
    low.set(row, visited++)
    stack.push(row)
  }
  for (const root of plan.keys()) {
    if (index.has(root)) continue
    visit(root)
    const frames = [{ row: root, edge: 0 }]
    while (frames.length) {
      const frame = frames[frames.length - 1]!
      const targets = plan.get(frame.row)!
      if (frame.edge < targets.length) {
        const to = targets[frame.edge++]!
        if (!plan.has(to)) continue
        if (!index.has(to)) {
          visit(to)
          frames.push({ row: to, edge: 0 })
        } else if (!component.has(to)) {
          // still on the stack: part of the component being built
          low.set(frame.row, Math.min(low.get(frame.row)!, index.get(to)!))
        }
        continue
      }
      frames.pop()
      const parent = frames[frames.length - 1]
      if (parent) low.set(parent.row, Math.min(low.get(parent.row)!, low.get(frame.row)!))
      if (low.get(frame.row) !== index.get(frame.row)) continue
      let member: string
      do {
        member = stack.pop()!
        component.set(member, found)
      } while (member !== frame.row)
      found++
    }
  }
  return component
}

// The shortest chain of waits_on from `start` to `goal` over rows that exist,
// both ends included; null when there is none.
function waitsOnPath(plan: PlanWaits, start: string, goal: string): string[] | null {
  const previous = new Map<string, string>()
  const queue = [start]
  const seen = new Set(queue)
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]!
    if (at === goal) {
      const path = [at]
      for (let step = previous.get(at); step !== undefined; step = previous.get(step)) path.push(step)
      return path.reverse()
    }
    for (const next of plan.get(at) ?? []) {
      if (!plan.has(next) || seen.has(next)) continue
      seen.add(next)
      previous.set(next, at)
      queue.push(next)
    }
  }
  return null
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
  headRepo?: string | null
  /** issue #103 PR2: omitted keeps the stored pin; null clears it */
  issuePin?: IssueLink | null
}

export function upsertBoard(db: Database.Database, input: UpsertBoardInput): { boardId: string; rowCount: number } {
  const run = db.transaction((inp: UpsertBoardInput): { boardId: string; rowCount: number } => {
    const labels = new Set(inp.rows.map((row) => row.label))
    if (labels.size !== inp.rows.length) throw new Error(`duplicate board row label in "${inp.title}"`)
    // refuse a bad link or waits_on shape before anything is written
    if (inp.issuePin) issueLinkColumns(inp.issuePin)
    for (const r of inp.rows) if (r.issue) issueLinkColumns(r.issue)
    const waits = new Map<string, string[]>()
    for (const r of inp.rows) if (r.waits_on !== undefined) waits.set(r.label, waitsOnLabels(r.label, r.waits_on))
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
      || before.head_repo !== (inp.headRepo ?? null)
    const boardId = ensureBoard(db, inp, now)
    boardChanged = setBoardIssuePin(db, boardId, inp.issuePin) || boardChanged
    const existing = db.prepare(`SELECT id, label, status, note, position, action_version, revision, waits_on FROM board_rows WHERE board_id = ?`).all(boardId) as Array<{
      id: string
      label: string
      status: RowStatus
      note: string
      position: number
      action_version: number
      revision: number
      waits_on: string | null
    }>
    const priorWaits: PlanWaits = new Map(existing.map((r) => [r.label, parseWaitsOn(r.waits_on) ?? []]))
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
        if (newAction) beginNewRowAction(db, existingId, now, inp.agent)
        let rowChanged = newAction
          || prev.status !== r.status
          || prev.note !== (r.note ?? prev.note)
        // Moving a row is not a change to the row (#158). Its revision is the CAS
        // token a native notification pins, and its updated_at means content
        // changed, so a move bumps neither. Only the board revision records it,
        // which still refuses any full-table snapshot taken before the move.
        const moved = prev.position !== i
        // annotation column is deliberately NOT touched — human notes survive
        db.prepare(`
          UPDATE board_rows
             SET status = @status,
                 note = @note,
                 position = @position,
                 updated_at = CASE
                   WHEN status IS NOT @status OR note IS NOT @note
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
        rowChanged = setRowIssueLink(db, existingId, r.issue, now) || rowChanged
        rowChanged = setRowWaitsOn(db, existingId, waits.get(r.label), now) || rowChanged
        if (r.outcome !== undefined) rowChanged = setRowOutcome(db, existingId, r.outcome, now) || rowChanged
        if (!newAction && rowChanged) incrementRowRevision(db, existingId)
        boardChanged = boardChanged || rowChanged || moved
      } else {
        boardChanged = true
        const issue = issueLinkColumns(r.issue ?? null)
        db.prepare(`
          INSERT INTO board_rows (
            id, board_id, label, status, note, next_step, action_owner, impact,
            next_after, options, context, outcome, outcome_at, created_at,
            updated_at, action_started_at, action_version, action_agent, action_agent_version,
            revision, history, position, issue_repo, issue_number, waits_on)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 1, '[]', ?, ?, ?, ?)`)
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
            inp.agent,
            i,
            issue.repo,
            issue.number,
            waitsOnColumn(waits.get(r.label)),
          )
      }
    })
    for (const r of existing) {
      if (incoming.has(r.label)) continue
      db.prepare(`DELETE FROM board_rows WHERE id = ?`).run(r.id)
      boardChanged = true
    }
    // only a row this write gave waits_on can close a cycle: a returning row
    // without one can be waited on, never wait on anything
    if (waits.size) checkWaitsOn(db, boardId, priorWaits, waits)
    boardChanged = syncBoardStatus(db, boardId) || boardChanged
    if (before && boardChanged) bumpBoardRevision(db, boardId, now)
    return { boardId, rowCount: inp.rows.length }
  })
  return run.immediate(input)
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
  headRepo?: string | null
  /** issue #103 PR2: omitted keeps the stored link; null clears it */
  issue?: IssueLink | null
  /** issue #103 slice 2: labels of other rows of this plan; omitted keeps, [] clears */
  waits_on?: string[]
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

// The asker is stamped in the SAME statement that moves action_version, which is
// what lets reset_row_action_watch_state keep it while clearing the stop.
function beginNewRowAction(db: Database.Database, rowId: string, now: string, agent: string | null): number {
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
           pinned_at = NULL,
           outcome = '',
           outcome_at = NULL,
           action_started_at = ?,
           action_version = ?,
           action_agent = ?,
           action_agent_version = ?,
           revision = revision + 1,
           history = ?,
           updated_at = ?
     WHERE id = ?`)
    .run(now, nextVersion, agent, nextVersion, JSON.stringify(history), now, rowId)
  return nextVersion
}

export interface AdvanceBoardRowInput {
  project: string
  title: string
  label: string
  // the asking agent of the new action; omitted, it is recorded as unknown
  agent?: string
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
    const version = beginNewRowAction(db, row.id, now, inp.agent ?? null)
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
    const issue = inp.issue === undefined ? undefined : issueLinkColumns(inp.issue)
    const waits = inp.waits_on === undefined ? undefined : waitsOnLabels(inp.label, inp.waits_on)
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
      || before!.head_repo !== (inp.headRepo ?? null)
    )
    const boardId = ensureBoard(db, inp, now)
    const priorWaits = waits === undefined ? undefined : planWaitsOn(db, boardId)
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
        if (newAction) beginNewRowAction(db, existing.id, now, inp.agent)
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
      rowChanged = setRowIssueLink(db, existing.id, inp.issue, now) || rowChanged
      rowChanged = setRowWaitsOn(db, existing.id, waits, now) || rowChanged
      if (inp.outcome !== undefined) rowChanged = setRowOutcome(db, existing.id, inp.outcome, now) || rowChanged
      if (priorWaits && waits) checkWaitsOn(db, boardId, priorWaits, new Map([[inp.label, waits]]))
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
        action_started_at, action_version, action_agent, action_agent_version, revision, history, position,
        issue_repo, issue_number, waits_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 1, '[]', ?, ?, ?, ?)`)
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
        inp.agent,
        pos,
        issue?.repo ?? null,
        issue?.number ?? null,
        waitsOnColumn(waits),
      )
    if (priorWaits && waits) checkWaitsOn(db, boardId, priorWaits, new Map([[inp.label, waits]]))
    syncBoardStatus(db, boardId)
    if (before) bumpBoardRevision(db, boardId, now)
    return { boardId, rowId }
  })
  return run.immediate(input)
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
  inp: { project: string; stream: string; agent: string; title: string; repo?: string | null; issueRef?: number | null; headRepo?: string | null },
  now: string,
): string {
  const board = findBoard(db, inp.project, inp.title)
  // #30's repo/issue_ref (and #157's head_repo) are restamped on every write,
  // exactly like stream and agent — the board follows whoever is writing to it
  // now. They belong on the `boards` row and nowhere near board_rows, whose
  // annotation column is the human's and must survive every re-upsert untouched.
  if (board) {
    db.prepare(`UPDATE boards
                   SET stream = ?, agent = ?, repo = ?, issue_ref = ?, head_repo = ?,
                       updated_at = CASE
                         WHEN stream IS NOT ? OR agent IS NOT ? OR repo IS NOT ? OR issue_ref IS NOT ? OR head_repo IS NOT ?
                         THEN ? ELSE updated_at END
                 WHERE id = ?`)
      .run(
        inp.stream,
        inp.agent,
        inp.repo ?? null,
        inp.issueRef ?? null,
        inp.headRepo ?? null,
        inp.stream,
        inp.agent,
        inp.repo ?? null,
        inp.issueRef ?? null,
        inp.headRepo ?? null,
        now,
        board.id,
      )
    return board.id
  }
  const boardId = randomUUID()
  db.prepare(`INSERT INTO boards (id, project, stream, agent, title, repo, issue_ref, head_repo, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run(boardId, inp.project, inp.stream, inp.agent, inp.title, inp.repo ?? null, inp.issueRef ?? null, inp.headRepo ?? null, now, now)
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
  const answerKind = annotation ? kind : null
  const run = db.transaction((): boolean => {
    // An answer ends a pin (#247) exactly where clear_row_pin_when_ask_ends
    // would; a cleared note answers nothing and leaves it.
    const row = db.prepare(`UPDATE board_rows
                               SET annotation = ?, annotation_kind = ?, annotated_at = ?,
                                   annotation_seen_at = NULL, annotation_seen_by = NULL,
                                   snoozed_until = NULL,
                                   pinned_at = CASE WHEN ? IS NOT NULL THEN NULL ELSE pinned_at END,
                                   updated_at = ?, revision = revision + 1
                             WHERE id = ? AND (? IS NULL OR revision = ?)
                               AND EXISTS (
                                 SELECT 1 FROM boards b
                                  WHERE b.id = board_rows.board_id
                                    AND b.status = 'active'
                                    AND (? IS NULL OR b.revision = ?))
                             RETURNING board_id`)
      .get(
        annotation,
        answerKind,
        now,
        answerKind,
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
    // Unanswered means empty-or-NULL, as in listUnansweredBoardRows and
    // attention.js: annotateBoardRow stores a cleared note as '' (#160).
    // A snooze with a time replaces a pin (#247); waking (null) leaves one alone.
    const row = db.prepare(`UPDATE board_rows
                               SET snoozed_until = ?,
                                   pinned_at = CASE WHEN ? IS NOT NULL THEN NULL ELSE pinned_at END,
                                   updated_at = ?, revision = revision + 1
                             WHERE id = ? AND status = 'blocked'
                               AND (? IS NULL OR revision = ?)
                               AND COALESCE(annotation, '') = '' AND annotation_kind IS NULL
                               AND handled_at IS NULL
                               AND EXISTS (
                                 SELECT 1 FROM boards b
                                  WHERE b.id = board_rows.board_id
                                    AND b.status = 'active'
                                    AND (? IS NULL OR b.revision = ?))
                             RETURNING board_id`)
      .get(
        until,
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

// Issue #217 — the row twin of stopItemWatch, pinned like every human row action
// to the row AND board revisions the human was looking at, so a stale click can
// never stop a newer ask that reused this stable row id. Unlike snooze it bumps
// neither revision nor updated_at: it changes nothing an agent writes, so an
// agent's board_get → board_upsert snapshot stays valid and a native
// notification is not re-announced. The one reset is a new action, by any
// writer (reset_row_action_watch_state). `defer` (#247) also pins the row
// (stop for good) or snoozes it to the same time against the same revisions,
// exactly as pinBoardRow or snoozeBoardRow would, in the same transaction: the
// snooze half moves the revisions as any snooze does, the pin half moves none.
export function stopBoardRowWatch(
  db: Database.Database,
  rowId: string,
  until: string | null,
  expectedRevision: number,
  expectedBoardRevision: number,
  { defer = false }: StopWatchOptions = {},
): boolean {
  const stop = (): boolean => db.prepare(`UPDATE board_rows SET watch_stopped_at = @now, watch_stopped_until = @until
                            WHERE id = @id AND status = 'blocked' AND revision = @revision
                              AND COALESCE(annotation, '') = '' AND annotation_kind IS NULL
                              AND handled_at IS NULL
                              AND (watch_stopped_at IS NULL OR watch_stopped_until IS NOT NULL)
                              AND EXISTS (
                                SELECT 1 FROM boards b
                                 WHERE b.id = board_rows.board_id
                                   AND b.status = 'active'
                                   AND b.revision = @boardRevision)`)
    .run({ id: rowId, until, revision: expectedRevision, boardRevision: expectedBoardRevision, now: new Date().toISOString() })
    .changes > 0
  if (!defer) return stop()
  return stopAndDefer(db, stop, () => (until === null
    ? pinBoardRow(db, rowId, true, expectedRevision, expectedBoardRevision)
    : snoozeBoardRow(db, rowId, until, expectedRevision, expectedBoardRevision)))
}

// Issue #247 — the row twin of pinItem, pinned like every human row action to
// the row AND board revisions the human saw, so a stale click can never pin or
// unpin a newer ask that reused this stable row id. Like the #217 watch stop it
// bumps neither revision nor updated_at: a pin changes nothing an agent writes,
// so an agent's board_get → board_upsert snapshot stays valid and a native
// notification keyed by revision is not re-announced. A new action, an answer,
// a handled mark or a move out of blocked clears it (clear_row_pin_when_ask_ends).
export function pinBoardRow(
  db: Database.Database,
  rowId: string,
  pinned: boolean,
  expectedRevision: number,
  expectedBoardRevision: number,
): boolean {
  const pins = { id: rowId, revision: expectedRevision, boardRevision: expectedBoardRevision }
  const info = pinned
    ? db.prepare(`UPDATE board_rows SET pinned_at = COALESCE(pinned_at, @now), snoozed_until = NULL
                   WHERE id = @id AND status = 'blocked' AND revision = @revision
                     AND COALESCE(annotation, '') = '' AND annotation_kind IS NULL
                     AND handled_at IS NULL
                     AND EXISTS (
                       SELECT 1 FROM boards b
                        WHERE b.id = board_rows.board_id
                          AND b.status = 'active'
                          AND b.revision = @boardRevision)`)
      .run({ ...pins, now: new Date().toISOString() })
    : db.prepare(`UPDATE board_rows SET pinned_at = NULL
                   WHERE id = @id AND pinned_at IS NOT NULL AND revision = @revision
                     AND EXISTS (
                       SELECT 1 FROM boards b
                        WHERE b.id = board_rows.board_id
                          AND b.status = 'active'
                          AND b.revision = @boardRevision)`)
      .run(pins)
  return info.changes > 0
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
                     snoozed_until = NULL, pinned_at = NULL, updated_at = ?, revision = revision + 1
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
  version?: { row: number; board: number },
): boolean {
  const info = db
    .prepare(`UPDATE board_rows SET handled_seen_at = COALESCE(handled_seen_at, ?),
                                    handled_seen_by = COALESCE(handled_seen_by, ?)
               WHERE id = ? AND handled_at IS NOT NULL AND handled_at IS ?
                 AND (? IS NULL OR revision = ?)
                 AND (? IS NULL OR EXISTS (
                   SELECT 1 FROM boards b WHERE b.id = board_rows.board_id AND b.revision = ?))`)
    .run(new Date().toISOString(), by, rowId, handledAt,
      version?.row ?? null, version?.row ?? null, version?.board ?? null, version?.board ?? null)
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
  version?: { row: number; board: number },
): boolean {
  const info = db
    .prepare(`UPDATE board_rows SET annotation_seen_at = COALESCE(annotation_seen_at, ?),
                                    annotation_seen_by = COALESCE(annotation_seen_by, ?)
               WHERE id = ? AND annotated_at IS ?
                 AND (? IS NULL OR revision = ?)
                 AND (? IS NULL OR EXISTS (
                   SELECT 1 FROM boards b WHERE b.id = board_rows.board_id AND b.revision = ?))`)
    .run(new Date().toISOString(), by, rowId, annotatedAt,
      version?.row ?? null, version?.row ?? null, version?.board ?? null, version?.board ?? null)
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
  pinned_at: string | null
  outcome: string
  outcome_at: string | null
  action_started_at: string
  action_version: number
  revision: number
  updated_at: string
}

export function getActiveBoardRow(db: Database.Database, rowId: string): BoardRow | undefined {
  const row = db.prepare(`SELECT ${ROW_COLUMNS} FROM board_rows
    WHERE id = ? AND EXISTS (
      SELECT 1 FROM boards WHERE boards.id = board_rows.board_id AND boards.status = 'active'
    )`).get(rowId) as BoardRowRecord | undefined
  return row ? withUnseen([row])[0] : undefined
}

export function listUnansweredBoardRows(
  db: Database.Database,
  project: string,
): Array<Pick<BoardRow, 'id' | 'action_version'>> {
  return db.prepare(`SELECT r.id, r.action_version
    FROM board_rows r JOIN boards b ON b.id = r.board_id
    WHERE b.project = ? AND b.status = 'active' AND r.status = 'blocked'
      AND COALESCE(r.annotation, '') = '' AND r.annotation_kind IS NULL
      AND r.handled_at IS NULL`).all(project) as Array<Pick<BoardRow, 'id' | 'action_version'>>
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
              r.pinned_at AS pinned_at,
              r.outcome AS outcome, r.outcome_at AS outcome_at,
              r.action_started_at AS action_started_at, r.action_version AS action_version,
              r.revision AS revision,
              r.updated_at AS updated_at
         FROM board_rows r JOIN boards b ON b.id = r.board_id
        WHERE b.project = ? AND b.status = 'active'
          AND (r.snoozed_until > ?
               OR (r.pinned_at IS NOT NULL AND r.status = 'blocked')
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

// Issue #287: the plans for the Electron dock watcher's 3-second poll. Of a plan,
// the shared predicate and the response watch read only its blocked rows, so
// this keeps listBoards' active plans that hold one, in its order, each narrowed
// to those rows; every plan field, `progress` over all its rows included, is
// listBoards' (test/reply-watch.test.ts pins that the dock derives the same
// results from either). It runs listBoards' plan statement, so ties keep its
// order, and never parses or serializes another row, which the default
// representation would cost in Electron main after every write.
export function listBoardsWithBlockedRows(db: Database.Database): BoardWithRows[] {
  const boards = db.prepare(`SELECT * FROM boards WHERE status = ? ORDER BY updated_at DESC`).all('active') as Board[]
  const rowStmt = db.prepare(`SELECT ${ROW_COLUMNS} FROM board_rows
    WHERE board_id = ? AND status = 'blocked' ORDER BY position ASC`)
  const statusStmt = db.prepare(`SELECT status FROM board_rows WHERE board_id = ?`)
  const out: BoardWithRows[] = []
  for (const b of boards) {
    const rows = withUnseen(rowStmt.all(b.id) as BoardRowRecord[])
    if (rows.length) out.push({ ...b, rows, progress: computeProgress(statusStmt.all(b.id) as BoardRow[]) })
  }
  return out
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
  /** The Agent Inbox build the session's MCP server runs (issue #197). NULL when unknown. */
  server_version: string | null
  /** Where that server runs from: 'runtime' or 'checkout' (issue #197). NULL when unknown. */
  server_source: string | null
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
  /**
   * The Agent Inbox build this session's MCP server runs, and where it runs
   * from (issue #197). Written in either mode; a write that omits either keeps
   * the stored value, so only a caller that knows it can set it and none can
   * clear it.
   */
  server_version?: string
  server_source?: ServerSource
  /**
   * The process that started this session's MCP server and the server's own
   * pid (issue #253), which let a Claude Code hook find the servers of its own
   * session. Kept on omission, like the build fields.
   */
  host_pid?: number
  server_pid?: number
}

// One statement for the `activity` presence row, plus (when this write is a
// real claim, not mere registration) a span transition — both inside the same
// transaction, so a crash between them can never leave a claim recorded in one
// table and not the other. See "── activity spans" below for the span rules.
const upsertActivityTxn = (db: Database.Database, a: ActivityUpdate): void => {
  const now = new Date().toISOString()
  const nowMs = Date.now()
  // One statement, two modes. Registration can create idle presence but can
  // neither replace a live claim nor write its historical caption.
  db.prepare(
    `INSERT INTO activity (session, project, stream, agent, doing, last_doing, detail, children, idle, started_at, updated_at, server_version, server_source, host_pid, server_pid)
     VALUES (
       @session, @project, @stream, @agent, @doing,
       CASE WHEN @claim = 1 AND @idle = 0 AND @doing <> '' AND @doing <> 'open' THEN @doing ELSE '' END,
       @detail, @children, @idle, @now, @now, @server_version, @server_source, @host_pid, @server_pid
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
       server_version = COALESCE(@server_version, server_version),
       server_source  = COALESCE(@server_source, server_source),
       host_pid   = COALESCE(@host_pid, host_pid),
       server_pid = COALESCE(@server_pid, server_pid),
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
    server_version: a.server_version ?? null,
    server_source: a.server_source ?? null,
    host_pid: a.host_pid ?? null,
    server_pid: a.server_pid ?? null,
    now,
  })
  // Registration (`claim: false`) never touches spans — it is not speaking for
  // the agent, so it must not open, extend or close one.
  if (a.claim !== false) {
    const isMeaningful = !a.idle && a.doing !== '' && a.doing !== 'open'
    transitionClaimSpan(db, {
      session: a.session,
      project: a.project,
      stream: a.stream,
      agent: a.agent,
      doing: a.doing,
      isMeaningful,
      nowIso: now,
      nowMs,
    })
  }
  // housekeeping: rows dead (ended or silent) for over a day serve no one
  const dayAgo = new Date(nowMs - 24 * 60 * 60000).toISOString()
  db.prepare(`DELETE FROM activity WHERE (ended_at IS NOT NULL AND ended_at < ?) OR updated_at < ?`).run(dayAgo, dayAgo)
  pruneActivitySpans(db, { nowMs })
}

export function upsertActivity(db: Database.Database, a: ActivityUpdate): void {
  db.transaction(() => upsertActivityTxn(db, a)).immediate()
}

export function endActivity(db: Database.Database, session: string): void {
  db.transaction(() => {
    const now = new Date().toISOString()
    const nowMs = Date.now()
    db.prepare(`UPDATE activity SET ended_at = ? WHERE session = ?`).run(now, session)
    closeOpenSpan(db, session, nowMs)
  })()
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

// How long a presence row outlives its last liveness tick (5 minutes apart):
// past this, its server crashed rather than went quiet.
const PRESENCE_STALE_MINUTES = 15

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
  db.transaction(() => {
    const now = new Date().toISOString()
    const nowMs = Date.now()
    const cold = claimCutoff(nowMs)
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
    // Mirror the same warm/cold split onto the open span, if any: still warm
    // just proves continued work (bump last_active_at to now); already cold
    // closes it at the exact cap it went stale at — never extended to now, or
    // a routine poll after a long silence would overstate how long it ran.
    const open = db
      .prepare(`SELECT id, last_active_at FROM activity_spans WHERE session = ? AND ended_at IS NULL`)
      .get(session) as { id: number; last_active_at: string } | undefined
    if (open) {
      if (open.last_active_at < cold) {
        db.prepare(`UPDATE activity_spans SET ended_at = ? WHERE id = ?`)
          .run(cappedSpanEnd(open.last_active_at, nowMs), open.id)
      } else {
        db.prepare(`UPDATE activity_spans SET last_active_at = ? WHERE id = ?`).run(now, open.id)
      }
    }
  })()
}

export function listActivity(db: Database.Database, opts: { staleMinutes?: number } = {}): Activity[] {
  const now = Date.now()
  const cutoff = new Date(now - (opts.staleMinutes ?? PRESENCE_STALE_MINUTES) * 60000).toISOString()
  const cold = claimCutoff(now)
  const rows = db
    .prepare(`SELECT session, project, stream, agent, doing, last_doing, detail, children, idle, started_at, updated_at, last_call_at, server_version, server_source
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

// ── issue #253: what a Claude Code hook may know about its own session ──────
//
// The hook and the session's stdio MCP server are both children of the Claude
// Code process, and the server records that parent as `host_pid`. These reads
// find a live session's servers by it: only rows still refreshed by their
// heartbeat and not ended, as in listActivity. Whether each server process is
// still running is the caller's check, not the store's.
export interface HostSession {
  session: string
  project: string
  server_pid: number | null
}

export function listHostSessions(db: Database.Database, hostPid: number): HostSession[] {
  const cutoff = new Date(Date.now() - PRESENCE_STALE_MINUTES * 60000).toISOString()
  return db
    .prepare(`SELECT session, project, server_pid FROM activity
               WHERE host_pid = ? AND ended_at IS NULL AND updated_at >= ?
               ORDER BY started_at ASC, session ASC`)
    .all(hostPid, cutoff) as HostSession[]
}

// The open questions these MCP sessions raised, whatever project each was
// filed under.
export function listSessionQuestions(db: Database.Database, sessions: readonly string[]): Item[] {
  if (sessions.length === 0) return []
  const rows = db
    .prepare(`SELECT * FROM items
               WHERE status = 'open' AND kind = 'question'
                 AND session IN (SELECT value FROM json_each(?))
               ORDER BY created_at ASC`)
    .all(JSON.stringify(sessions)) as StoredItem[]
  return rows.map(parseItem)
}

// The Claude hook's answer-watcher lease: one row per watched host (or harness
// session). A newer Stop's claim replaces the token, so the older watcher sees
// it has lost the lease at its next poll and exits. Release deletes only the
// caller's own token, so a watcher can never drop a newer watcher's lease.
// Leases a killed watcher left behind are pruned after a day.
export function claimHookWatch(db: Database.Database, key: string, token: string): void {
  const now = Date.now()
  db.transaction(() => {
    db.prepare(`DELETE FROM hook_watch_claims WHERE claimed_at < ?`).run(new Date(now - 24 * 60 * 60000).toISOString())
    db.prepare(`INSERT INTO hook_watch_claims (claim_key, token, claimed_at) VALUES (?, ?, ?)
                ON CONFLICT(claim_key) DO UPDATE SET token = excluded.token, claimed_at = excluded.claimed_at`)
      .run(key, token, new Date(now).toISOString())
  }).immediate()
}

export function holdsHookWatch(db: Database.Database, key: string, token: string): boolean {
  return db.prepare(`SELECT 1 FROM hook_watch_claims WHERE claim_key = ? AND token = ?`).get(key, token) !== undefined
}

export function releaseHookWatch(db: Database.Database, key: string, token: string): void {
  db.prepare(`DELETE FROM hook_watch_claims WHERE claim_key = ? AND token = ?`).run(key, token)
}

// ── activity spans: truthful claim intervals, read-only for the dashboard ────
//
// `activity` is presence — one row per session, overwritten in place, with no
// history. A span records WHEN a meaningful, non-idle `doing` claim started and
// (once it ends) stopped, so a dashboard can draw "who worked on what, when"
// without changing a single bit of the existing attention/liveness semantics
// above. A span is additive and derived: nothing here is read by
// `listActivity`, `classifyLiveness` or any attention path.
//
// "Meaningful" mirrors the exact `last_doing` predicate already in
// `upsertActivityTxn`: a live claim (`claim !== false`), not idle, and a
// `doing` that is neither empty nor the synthetic `'open'` placeholder.
// Registration (`claim: false`) never reaches span code at all — see the call
// site in `upsertActivityTxn`.
export interface ActivitySpan {
  id: number
  session: string
  project: string
  stream: string
  agent: string
  doing: string
  started_at: string
  last_active_at: string
  ended_at: string | null
  /**
   * `ended_at` when the span is closed. For a still-open span: `null` while it
   * is genuinely warm (still within `CLAIM_COLD_MS` of `last_active_at`), or
   * the read-time cold cap (`last_active_at + CLAIM_COLD_MS`) once it has gone
   * stale without anything (a heartbeat, a call, a clean exit) closing it —
   * the kill-9 case. Never mutates the row; purely a read-time projection.
   */
  effective_ended_at: string | null
}

// A crash, a `kill -9`, a laptop closing mid-task — none of them call
// `endActivity`. Without a cap, that open span would silently claim work all
// the way up to whenever `listActivitySpans` happens to be read. The cap
// matches `recordActivityCall`'s and `listActivity`'s own decay: an untouched
// claim is only ever truthful up to `last_active_at + CLAIM_COLD_MS`.
function cappedSpanEnd(lastActiveAt: string, nowMs: number): string {
  const cap = Date.parse(lastActiveAt) + CLAIM_COLD_MS
  return cap < nowMs ? new Date(cap).toISOString() : new Date(nowMs).toISOString()
}

type OpenSpan = Pick<ActivitySpan, 'id' | 'project' | 'stream' | 'agent' | 'doing' | 'last_active_at'>

function openSpan(db: Database.Database, session: string): OpenSpan | undefined {
  return db
    .prepare(`SELECT id, project, stream, agent, doing, last_active_at FROM activity_spans WHERE session = ? AND ended_at IS NULL`)
    .get(session) as OpenSpan | undefined
}

function closeOpenSpan(db: Database.Database, session: string, nowMs: number): void {
  const open = openSpan(db, session)
  if (!open) return
  db.prepare(`UPDATE activity_spans SET ended_at = ? WHERE id = ?`).run(cappedSpanEnd(open.last_active_at, nowMs), open.id)
}

interface ClaimSpanInput {
  session: string
  project: string
  stream: string
  agent: string
  doing: string
  isMeaningful: boolean
  nowIso: string
  nowMs: number
}

// The one place that decides span lifecycle for a real (`claim !== false`)
// activity write. There are exactly four outcomes, and the "stale" case is not
// a fifth branch bolted on — it falls out of comparing against the SAME cold
// cutoff `recordActivityCall`/`listActivity` already use:
//   • no open span, meaningful doing   → open one
//   • no open span, not meaningful     → nothing to do
//   • open span, same doing in the same scope (project, stream, agent), still
//     warm → same live claim: bump last_active_at, no new row
//   • open span, otherwise (doing or scope changed, now idle/open/done, OR the
//     prior span already went cold) → close the prior span truthfully (capped,
//     so a stale close can never read as "worked until now") and, if this write
//     is itself meaningful, open a fresh span — this is also how a claim
//     reasserted after a cold gap gets its own new interval instead of
//     silently extending the old one across the gap.
// Scope is part of a claim's identity (#162). Presence takes the latest scope on
// every write, so comparing `doing` alone kept crediting a claim re-reported after
// register() or a branch checkout to the OLD project and stream.
function transitionClaimSpan(db: Database.Database, input: ClaimSpanInput): void {
  const { session, project, stream, agent, doing, isMeaningful, nowIso, nowMs } = input
  const open = openSpan(db, session)
  if (open) {
    const stale = open.last_active_at < claimCutoff(nowMs)
    const sameScope = open.project === project && open.stream === stream && open.agent === agent
    const sameLiveClaim = isMeaningful && open.doing === doing && sameScope && !stale
    if (sameLiveClaim) {
      db.prepare(`UPDATE activity_spans SET last_active_at = ? WHERE id = ?`).run(nowIso, open.id)
      return
    }
    db.prepare(`UPDATE activity_spans SET ended_at = ? WHERE id = ?`).run(cappedSpanEnd(open.last_active_at, nowMs), open.id)
  }
  if (isMeaningful) {
    db.prepare(
      `INSERT INTO activity_spans (session, project, stream, agent, doing, started_at, last_active_at, ended_at)
       VALUES (@session, @project, @stream, @agent, @doing, @now, @now, NULL)`,
    ).run({ session, project, stream, agent, doing, now: nowIso })
  }
}

// 90 days is a generous, opportunistic backstop — not a feature. It exists so
// that a crash-only session (never ended, never heartbeated again) cannot
// accumulate rows forever; it rides along on the same cleanup pass as the
// day-old `activity` sweep, so there is no separate timer or table to forget.
const ACTIVITY_SPAN_RETENTION_MS = 90 * 24 * 60 * 60000

function pruneActivitySpans(db: Database.Database, opts: { nowMs?: number } = {}): void {
  const nowMs = opts.nowMs ?? Date.now()
  const closedCutoff = new Date(nowMs - ACTIVITY_SPAN_RETENTION_MS).toISOString()
  db.prepare(`DELETE FROM activity_spans WHERE ended_at IS NOT NULL AND ended_at < ?`).run(closedCutoff)
  // A still-open span whose EFFECTIVE (capped) end already fell out of
  // retention is a kill-9 leftover: last_active_at + CLAIM_COLD_MS < cutoff.
  const staleOpenCutoff = new Date(nowMs - ACTIVITY_SPAN_RETENTION_MS - CLAIM_COLD_MS).toISOString()
  db.prepare(`DELETE FROM activity_spans WHERE ended_at IS NULL AND last_active_at < ?`).run(staleOpenCutoff)
}

// Read-only, for the dashboard. `project`/`sinceMs` narrow the result, but
// deliberately by OVERLAP, not by start time: a span that started before the
// window but is still open (or closed inside it) is still relevant to "what
// happened since sinceMs", so it must not be filtered out just because it
// started earlier.
//
// The overlap runs in SQL (issue #161), so only overlapping rows are read, with
// the comparisons the old JavaScript filter made: a closed span overlaps when
// `ended_at >= since`; an open one while warm (`last_active_at >= cold`) or
// while its capped end still reaches `since`. Stamps are fixed-width
// toISOString() values, so that end (`last_active_at + CLAIM_COLD_MS`, below
// now once stale) reaches `since` exactly when `last_active_at` reaches
// `since - CLAIM_COLD_MS`. An extended-year `since` ('+010000-…') sorts below
// every four-digit stamp, so it admits every stale span, as before. `id` pins
// the tie order the old full scan produced, whatever plan the index allows.
export function listActivitySpans(
  db: Database.Database,
  opts: { project?: string; sinceMs?: number } = {},
): ActivitySpan[] {
  const nowMs = Date.now()
  const cold = claimCutoff(nowMs)
  const select = `SELECT id, session, project, stream, agent, doing, started_at, last_active_at, ended_at
         FROM activity_spans
        WHERE (@project IS NULL OR project = @project)`
  const project = opts.project ?? null
  let rows: Array<Omit<ActivitySpan, 'effective_ended_at'>>
  if (opts.sinceMs === undefined) {
    rows = db.prepare(`${select} ORDER BY started_at ASC, id ASC`).all({ project }) as typeof rows
  } else {
    const sinceDate = new Date(opts.sinceMs)
    const since = sinceDate.toISOString()
    const staleSince = /^\d{4}-/.test(since) ? new Date(sinceDate.getTime() - CLAIM_COLD_MS).toISOString() : ''
    rows = db
      .prepare(
        `${select}
          AND (ended_at >= @since
               OR (ended_at IS NULL AND (last_active_at >= @cold OR last_active_at >= @staleSince)))
        ORDER BY started_at ASC, id ASC`,
      )
      .all({ project, since, cold, staleSince }) as typeof rows
  }
  return rows.map((r): ActivitySpan => {
    const stillOpenButStale = r.ended_at === null && r.last_active_at < cold
    return { ...r, effective_ended_at: r.ended_at ?? (stillOpenButStale ? cappedSpanEnd(r.last_active_at, nowMs) : null) }
  })
}

export function getBoard(db: Database.Database, project: string, title: string): BoardWithRows | undefined {
  const board = findBoard(db, project, title)
  if (!board || board.status !== 'active') return undefined
  return boardWithRows(db, board)
}

// Issue #159 — ONE board by (project, title) WHATEVER its status. The titled MCP
// tools need an archived board too: board_get hands back its CAS revisions, and
// board_upsert/board_row demand board_version before a write reactivates it.
// They used to fall back to listBoards({ status: 'archived' }), loading and
// parsing every archived board in every project to find this one; this is the
// unique-key lookup plus that board's rows. getBoard() stays active-only.
export function getBoardByTitle(db: Database.Database, project: string, title: string): BoardWithRows | undefined {
  const board = findBoard(db, project, title)
  return board ? boardWithRows(db, board) : undefined
}

function boardWithRows(db: Database.Database, board: Board): BoardWithRows {
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
//
// Issue #157: a branch NAME is only unique within the repository it is pushed
// to, and `gh pr list --head` matches it in every fork. So the key is really
// (repo, branch, head_repo): the base the PR is searched in, the branch, and the
// head repository the cached PR was verified to come from. That lives in
// `source_links_by_head`. The original `source_links` table never recorded a
// head, so none of its rows can be verified (some are exactly the fork PRs #157
// is about); it is left in place only because older processes sharing this file
// still read and write it. Nothing here touches it. Changing its PRIMARY KEY in
// place would need a table rebuild, and that would break those processes'
// `ON CONFLICT(repo, branch)` upserts the moment any newer process migrated.

export interface SourcePreview {
  preview_url: string | null
  preview_environment: string | null
  preview_deployment_id: number | null
  preview_updated_at: string | null
  preview_error: string | null
}

export interface SourceLink extends SourcePreview {
  repo: string
  branch: string
  head_repo: string
  provider: string
  pr_number: number | null
  pr_url: string | null
  pr_title: string | null
  pr_state: string | null
  pr_head_sha: string | null
  pr_draft: boolean
  review_decision: string | null
  checks: string | null
  issue_number: number | null
  issue_url: string | null
  issue_title: string | null
  /**
   * issue #103: JSON `{ fetched_at, refs: [{ repo, number }] }`, every issue the
   * PR closes. Valid only while its fetched_at equals the row's: an older
   * process's upsert moves fetched_at without touching it, which unbinds it.
   */
  closing_refs: string | null
  tldr: string | null
  // when the last SUCCESSFUL fetch landed vs when we last tried at all — the
  // gap between them is exactly how stale a still-rendered good row is
  fetched_at: string | null
  checked_at: string
  error: string | null
  revision: number
}

export interface NewSourceLink extends Partial<SourcePreview> {
  repo: string
  branch: string
  // omitted means `repo` itself: the same-repository expectation
  head_repo?: string
  provider?: string
  pr_number?: number | null
  pr_url?: string | null
  pr_title?: string | null
  pr_state?: string | null
  pr_head_sha?: string | null
  pr_draft?: boolean
  review_decision?: string | null
  checks?: string | null
  issue_number?: number | null
  issue_url?: string | null
  issue_title?: string | null
  /** omitted or null: no record (a branch with no PR, or an unreadable list) */
  closing_refs?: Array<{ repo: string; number: number }> | null
  tldr?: string | null
}

export interface LinkTarget {
  repo: string
  branch: string
  // the EFFECTIVE expected head: the recorded head_repo, else `repo` itself
  head_repo: string
}

// a cache row unchecked for this long belongs to a branch nobody works on
const LINK_TTL_DAYS = 30
// hard ceiling on how many branches one refresh pass can ever consider
const MAX_LINK_TARGETS = 50

// The cache key. A '/' is legal in a slug and in a branch name, so the separator
// is a byte neither can contain (public/source.js keys its index the same way).
const linkKey = (repo: string, branch: string, head: string): string => `${repo}\u0000${branch}\u0000${head}`

// The closing references as stored: bound to the fetched_at written beside
// them. Any invalid reference voids the record, as parsePrPayload does.
function closingRefsRecord(refs: NewSourceLink['closing_refs'], fetchedAt: string): string | null {
  if (!Array.isArray(refs)) return null
  if (!refs.every((ref) => validIssueSlug(ref?.repo) && validIssueNumber(ref?.number))) return null
  return JSON.stringify({ fetched_at: fetchedAt, refs: refs.map(({ repo, number }) => ({ repo, number })) })
}

// A successful fetch: writes every field, stamps BOTH timestamps and clears the
// error. Housekeeping rides along, mirroring upsertActivity's day-old sweep.
export function upsertSourceLink(db: Database.Database, link: NewSourceLink): number {
  const now = new Date().toISOString()
  const result = db.prepare(
    `INSERT INTO source_links_by_head (repo, branch, head_repo, provider, pr_number, pr_url, pr_title, pr_state, pr_head_sha, pr_draft,
       review_decision, checks, issue_number, issue_url, issue_title, closing_refs, tldr, fetched_at, checked_at, error,
       preview_url, preview_environment, preview_deployment_id, preview_updated_at, preview_error)
     VALUES (@repo, @branch, @head_repo, @provider, @pr_number, @pr_url, @pr_title, @pr_state, @pr_head_sha, @pr_draft,
       @review_decision, @checks, @issue_number, @issue_url, @issue_title, @closing_refs, @tldr, @now, @now, NULL,
       @preview_url, @preview_environment, @preview_deployment_id, @preview_updated_at, @preview_error)
     ON CONFLICT(repo, branch, head_repo) DO UPDATE SET
       provider = @provider, pr_number = @pr_number, pr_url = @pr_url, pr_title = @pr_title,
       pr_state = @pr_state, pr_head_sha = @pr_head_sha, pr_draft = @pr_draft, review_decision = @review_decision, checks = @checks,
       issue_number = @issue_number, issue_url = @issue_url, issue_title = @issue_title, closing_refs = @closing_refs, tldr = @tldr,
       preview_url = @preview_url, preview_environment = @preview_environment,
       preview_deployment_id = @preview_deployment_id, preview_updated_at = @preview_updated_at,
       preview_error = @preview_error, revision = source_links_by_head.revision + 1,
       fetched_at = @now, checked_at = @now, error = NULL
     RETURNING revision`,
  ).get({
    repo: link.repo,
    branch: link.branch,
    head_repo: link.head_repo ?? link.repo,
    provider: link.provider ?? 'github',
    pr_number: link.pr_number ?? null,
    pr_url: link.pr_url ?? null,
    pr_title: link.pr_title ?? null,
    pr_state: link.pr_state ?? null,
    pr_head_sha: link.pr_head_sha ?? null,
    pr_draft: link.pr_draft ? 1 : 0,
    review_decision: link.review_decision ?? null,
    checks: link.checks ?? null,
    issue_number: link.issue_number ?? null,
    issue_url: link.issue_url ?? null,
    issue_title: link.issue_title ?? null,
    closing_refs: closingRefsRecord(link.closing_refs, now),
    preview_url: link.preview_url ?? null,
    preview_environment: link.preview_environment ?? null,
    preview_deployment_id: link.preview_deployment_id ?? null,
    preview_updated_at: link.preview_updated_at ?? null,
    preview_error: link.preview_error ?? null,
    tldr: link.tldr ?? null,
    now,
  }) as { revision: number }
  pruneSourceLinks(db)
  return result.revision
}

// A slow preview lookup must not overwrite a newer PR snapshot or failure.
export function setSourcePreview(
  db: Database.Database,
  target: { repo: string; branch: string; head_repo?: string; revision: number },
  preview: SourcePreview,
): boolean {
  return db.prepare(
    `UPDATE source_links_by_head SET preview_url = @preview_url, preview_environment = @preview_environment,
       preview_deployment_id = @preview_deployment_id, preview_updated_at = @preview_updated_at,
       preview_error = @preview_error, revision = revision + 1
     WHERE repo = @repo AND branch = @branch AND head_repo = @head_repo AND revision = @revision`,
  ).run({
    repo: target.repo, branch: target.branch, head_repo: target.head_repo ?? target.repo,
    revision: target.revision, ...preview,
  }).changes > 0
}

// A failed fetch keeps ordinary PR history, but invalidates its actionable
// preview: a URL whose current-head provenance cannot be refreshed is not safe
// to present as the change the human is being asked to approve.
// Every column except the key and checked_at is nullable precisely so this
// INSERT half can succeed for a branch that has never been fetched.
export function recordLinkFailure(
  db: Database.Database,
  f: { repo: string; branch: string; head_repo?: string; error: string },
): void {
  db.prepare(
    `INSERT INTO source_links_by_head (repo, branch, head_repo, checked_at, error) VALUES (@repo, @branch, @head_repo, @now, @error)
     ON CONFLICT(repo, branch, head_repo) DO UPDATE SET checked_at = @now, error = @error,
       preview_url = NULL, preview_environment = NULL, preview_deployment_id = NULL,
       preview_updated_at = NULL, preview_error = NULL, revision = source_links_by_head.revision + 1`,
  ).run({ repo: f.repo, branch: f.branch, head_repo: f.head_repo ?? f.repo, error: f.error, now: new Date().toISOString() })
}

export function listSourceLinks(db: Database.Database): SourceLink[] {
  const rows = db.prepare(`SELECT * FROM source_links_by_head ORDER BY repo ASC, branch ASC, head_repo ASC`).all() as Array<
    Omit<SourceLink, 'pr_draft'> & { pr_draft: number | null }
  >
  const active = rows.some((r) => r.preview_url)
    ? new Set(listLinkTargets(db).map((target) => linkKey(target.repo, target.branch, target.head_repo)))
    : null
  return rows.map((r) => ({
    ...r,
    pr_draft: r.pr_draft === 1,
    ...((r.preview_url && !active?.has(linkKey(r.repo, r.branch, r.head_repo))) ? {
      preview_url: null, preview_environment: null, preview_deployment_id: null,
      preview_updated_at: null, preview_error: null,
    } : {}),
  }))
}

// Which (repo, branch, head_repo) triples are worth spending a `gh` call on: the
// branches OPEN items and ACTIVE boards actually sit on, with the repository each
// expects its PR's head to come from (#157). A row that recorded no head (every
// row written before #157, or one with no github.com push remote or origin)
// expects a same-repository PR: its effective head is its own base `repo`. A
// resolved item's branch stops being refreshed but keeps whatever it last cached.
// A `gh pr checkout` branch of a fork PR without maintainer edits (#183)
// recorded the pull request ref it tracks, `refs/pull/<n>/head`, as its head.
// It names no repository, so no listed PR could verify: it is no target at all,
// and with no cache row its items show no PR chip.
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
      `SELECT project, repo, stream AS branch, COALESCE(NULLIF(head_repo, ''), repo) AS head_repo
         FROM items  WHERE status = 'open'   AND repo IS NOT NULL AND repo <> '' AND stream <> ''
       UNION
       SELECT project, repo, stream AS branch, COALESCE(NULLIF(head_repo, ''), repo) AS head_repo
         FROM boards WHERE status = 'active' AND repo IS NOT NULL AND repo <> '' AND stream <> ''
       ORDER BY repo ASC, branch ASC, head_repo ASC`,
    )
    .all() as Array<LinkTarget & { project: string }>
  const closed = new Set(closedProjects(db))
  // the UNION dedupes per project; the cache key is the triple, so the collapse
  // to one target per (repo, branch, head_repo) happens here instead
  const seen = new Set<string>()
  const targets: LinkTarget[] = []
  for (const row of rows) {
    if (closed.has(row.project)) continue
    if (row.head_repo.startsWith('refs/pull/')) continue
    const key = linkKey(row.repo, row.branch, row.head_repo)
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ repo: row.repo, branch: row.branch, head_repo: row.head_repo })
  }
  return targets.slice(0, MAX_LINK_TARGETS)
}

export function pruneSourceLinks(db: Database.Database, opts: { nowMs?: number } = {}): void {
  const cutoff = new Date((opts.nowMs ?? Date.now()) - LINK_TTL_DAYS * 24 * 60 * 60000).toISOString()
  db.prepare(`DELETE FROM source_links_by_head WHERE checked_at < ?`).run(cutoff)
}

// ── GitHub issue snapshots: the sub-issue cache (issue #103, PR1a) ──────────
//
// One cached GitHub answer per repo-qualified issue: the issue, its ancestor
// walk and its ordered children, as ONE validated JSON document replaced
// atomically, like a source_links_by_head row (design §4.3). The viewer's
// poller (PR1b) is the only production writer; src/issue-graph.ts reconciles
// what listIssueSnapshots returns, and /api/issues serves the result.
//
// The key is the REQUESTED owner/name#number. `repo` is COLLATE NOCASE because
// GitHub compares slugs case-insensitively, so a differently cased request
// reuses the row; equal numbers in different repositories never meet.
//
// THE ATTEMPT RULE: a write applies only when its attempt STARTED after the
// stored checked_at, so a slow answer from an older attempt can never replace a
// newer success or failure. It is the WHERE clause of one upsert, never a read
// followed by a write, so two viewers sharing the hub cannot interleave inside it.
//
// Slice 2 adds a second section in its own column, `dependencies`: GitHub's
// "blocked by" and "blocking" lists, fetched with the snapshot, written in the
// same statement and BOUND to that fetch's fetched_at. The v1 snapshot keeps
// its shape, so an older viewer still reads every row; its writes unbind the
// section instead of erasing it, and this build never trusts an unbound one.

export type IssueState = 'OPEN' | 'CLOSED'
export type IssueStateReason = 'COMPLETED' | 'NOT_PLANNED' | 'DUPLICATE' | 'REOPENED'
/** Soft: GitHub could not be asked. Hard: GitHub answered no (§5.8). */
export type IssueError =
  | 'offline' | 'rate-limit' | 'gh-failed' | 'no-gh' | 'auth'
  | 'not-found' | 'forbidden' | 'moved'

export interface IssueFacts {
  /** GitHub's own casing of nameWithOwner */
  repo: string
  number: number
  title: string
  state: IssueState
  state_reason: IssueStateReason | null
}

/** subIssuesSummary; requested only for the root's immediate parent and its children (§5.6). */
export interface IssueCounts {
  children_total: number
  children_completed: number
}

export type IssueRelative = IssueFacts & Partial<IssueCounts>

export type IssueHierarchy =
  | { status: 'ok'; total: number; completed: number; truncated: boolean; children: IssueRelative[] }
  | { status: 'unavailable' }

/** Snapshot JSON, version 1 (§4.3). */
export interface IssueSnapshot {
  v: 1
  issue: IssueFacts
  /** the walk upwards: [0] is the immediate parent, the only one with counts */
  ancestors: IssueRelative[]
  /** 'top': the walk reached an issue with no parent. 'limit': the last one's parent was not read. */
  ancestors_end: 'top' | 'limit'
  hierarchy: IssueHierarchy
}

/** One direction of an issue's GitHub dependencies (slice 2 §5.3). */
export interface IssueDependencyList {
  /** from issueDependenciesSummary: the open ones, and all of them (open and closed) */
  open: number
  total: number
  /** GitHub has more, or an entry was dropped: never evidence that an issue left the list */
  truncated: boolean
  /** the issues visible to the token, in key order (GitHub's order means nothing here) */
  list: IssueFacts[]
}

/** The dependency section fetched with a snapshot (slice 2 §5.3); `unavailable` carries no lists. */
export type IssueDependencies =
  | { status: 'ok'; blocked_by: IssueDependencyList; blocking: IssueDependencyList }
  | { status: 'unavailable' }

export interface IssueSnapshotRow {
  /** the requested owner/name, as first stored */
  repo: string
  number: number
  provider: string
  /** null before the first success, after a hard failure, or when the stored JSON is unreadable */
  snapshot: IssueSnapshot | null
  /**
   * Slice 2: the dependency section, only while it is valid, readable beside a
   * readable snapshot and BOUND to this row's fetched_at. null when it is
   * missing, unbound (an older viewer refreshed the row since) or unreadable:
   * "unknown", never "no dependencies".
   */
  dependencies: IssueDependencies | null
  /** start time of the attempt that produced `snapshot` */
  fetched_at: string | null
  /** start time of the latest applied attempt, whatever its outcome */
  checked_at: string
  error: string | null
  /** derived from `error`; a code this build does not know counts as soft */
  failure: 'soft' | 'hard' | null
  revision: number
}

/** The link fields of one open item, one active or archived plan, or one linked row of such a plan (§4.4). */
export interface IssueEntity {
  kind: 'item' | 'plan' | 'row'
  id: string
  project: string
  /** the project is in the EFFECTIVE closed set (#32) */
  project_closed: boolean
  /** an archived plan or a row of one; always false for an item */
  archived: boolean
  /** null for a row: a row's only issue source is its explicit link */
  repo: string | null
  stream: string
  head_repo: string | null
  issue_ref: number | null
  /** PR2: a plan's pin; null for items and rows */
  issue_pin_repo: string | null
  issue_pin_number: number | null
  /** PR2: a row's link; null for items and plans */
  issue_repo: string | null
  issue_number: number | null
  /** content time; a legacy item without updated_at falls back to created_at */
  updated_at: string
}

const ISSUE_SOFT_ERRORS = new Set(['offline', 'rate-limit', 'gh-failed', 'no-gh', 'auth'])
const ISSUE_HARD_ERRORS = new Set(['not-found', 'forbidden', 'moved'])
const ISSUE_HARD_ERRORS_SQL = [...ISSUE_HARD_ERRORS].map((code) => `'${code}'`).join(', ')
const ISSUE_STATES = new Set(['OPEN', 'CLOSED'])
const ISSUE_STATE_REASONS = new Set(['COMPLETED', 'NOT_PLANNED', 'DUPLICATE', 'REOPENED'])
// GraphQL Int, the largest issue number GitHub can name
const ISSUE_NUMBER_MAX = 2_147_483_647
// src/prstate.ts's TITLE_MAX (300) plus the ellipsis its clip() appends
const ISSUE_TITLE_MAX = 301
// GitHub's eight hierarchy levels, and its 100 sub-issues per parent
const ISSUE_ANCESTORS_MAX = 8
const ISSUE_CHILDREN_MAX = 100
// GitHub's 50 issues per dependency relationship type (slice 2 §2)
const ISSUE_DEPENDENCIES_MAX = 50
// a snapshot row unchecked for this long belongs to an issue nobody links
const ISSUE_TTL_DAYS = 30
// The attempt rule compares stored times as TEXT, so only this one canonical
// form (Date#toISOString) is accepted.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// parseRepoSlug's character class, without `.` or `..` as either part
// (resolvePreviewPayload's rule): a slug that could be read as a path is refused.
function validIssueSlug(repo: unknown): repo is string {
  return typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo)
    && repo.split('/').every((part) => part !== '.' && part !== '..')
}

function validIssueNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= ISSUE_NUMBER_MAX
}

const validIssueCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= ISSUE_NUMBER_MAX

function plainRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null
}

// One issue of a snapshot, rebuilt from its validated fields alone, so nothing
// else a caller attached (a body, a URL) is ever stored. `withCounts` says
// whether this position may carry child counts at all.
function issueRelative(value: unknown, withCounts: boolean): IssueRelative | null {
  const v = plainRecord(value)
  if (!v) return null
  const { repo, number, title, state, state_reason: reason } = v
  if (!validIssueSlug(repo) || !validIssueNumber(number)) return null
  if (typeof title !== 'string' || title.length > ISSUE_TITLE_MAX) return null
  if (typeof state !== 'string' || !ISSUE_STATES.has(state)) return null
  if (reason !== null && (typeof reason !== 'string' || !ISSUE_STATE_REASONS.has(reason))) return null
  const facts: IssueRelative = {
    repo, number, title, state: state as IssueState, state_reason: reason as IssueStateReason | null,
  }
  const hasTotal = 'children_total' in v
  const hasCompleted = 'children_completed' in v
  if (!hasTotal && !hasCompleted) return facts
  const { children_total: total, children_completed: completed } = v
  if (!withCounts || !validIssueCount(total) || !validIssueCount(completed) || completed > total) return null
  return { ...facts, children_total: total, children_completed: completed }
}

function issueRelatives(value: unknown, max: number, withCounts: (index: number) => boolean): IssueRelative[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  const out: IssueRelative[] = []
  for (const [index, entry] of value.entries()) {
    const node = issueRelative(entry, withCounts(index))
    if (!node) return null
    out.push(node)
  }
  return out
}

function issueHierarchy(value: unknown): IssueHierarchy | null {
  const v = plainRecord(value)
  if (v?.status === 'unavailable') return { status: 'unavailable' }
  if (v?.status !== 'ok') return null
  const { total, completed, truncated } = v
  if (!validIssueCount(total) || !validIssueCount(completed) || completed > total) return null
  if (typeof truncated !== 'boolean') return null
  const children = issueRelatives(v.children, ISSUE_CHILDREN_MAX, () => true)
  return children ? { status: 'ok', total, completed, truncated, children } : null
}

// The v1 validator, on write and on read. The issue must carry the number it
// was requested under; its repository may differ, because GitHub follows
// repository redirects (§4.1).
function issueSnapshot(value: unknown, number: number): IssueSnapshot | null {
  const v = plainRecord(value)
  if (!v || v.v !== 1) return null
  const issue = issueRelative(v.issue, false)
  if (!issue || issue.number !== number) return null
  const ancestors = issueRelatives(v.ancestors, ISSUE_ANCESTORS_MAX, (index) => index === 0)
  if (!ancestors) return null
  const end = v.ancestors_end
  if (end !== 'top' && !(end === 'limit' && ancestors.length > 0)) return null
  const hierarchy = issueHierarchy(v.hierarchy)
  return hierarchy ? { v: 1, issue, ancestors, ancestors_end: end, hierarchy } : null
}

function readIssueSnapshot(text: string | null, number: number): IssueSnapshot | null {
  if (text === null) return null
  try {
    return issueSnapshot(JSON.parse(text), number)
  } catch {
    return null
  }
}

function issueDependencyList(value: unknown): IssueDependencyList | null {
  const v = plainRecord(value)
  if (!v) return null
  const { open, total, truncated } = v
  if (!validIssueCount(open) || !validIssueCount(total) || open > total) return null
  if (typeof truncated !== 'boolean') return null
  const list = issueRelatives(v.list, ISSUE_DEPENDENCIES_MAX, () => false)
  return list ? { open, total, truncated, list } : null
}

// The slice-2 dependency section's validator, on write and on read, rebuilt
// from its validated fields alone. An unavailable section carries no lists.
function issueDependencies(value: unknown): IssueDependencies | null {
  const v = plainRecord(value)
  if (v?.status === 'unavailable') return { status: 'unavailable' }
  if (v?.status !== 'ok') return null
  const blockedBy = issueDependencyList(v.blocked_by)
  const blocking = issueDependencyList(v.blocking)
  return blockedBy && blocking ? { status: 'ok', blocked_by: blockedBy, blocking } : null
}

// A section is read only while BOUND: its own fetched_at must equal the row's.
// An older viewer's success moves the row's fetched_at without knowing this
// column, and an older hard failure clears it, so either one unbinds the
// section rather than erasing it (slice 2 §5.3, the closing_refs precedent).
function readIssueDependencies(text: string | null, fetchedAt: string | null): IssueDependencies | null {
  if (text === null || fetchedAt === null) return null
  try {
    const v = plainRecord(JSON.parse(text))
    return v && v.v === 1 && v.fetched_at === fetchedAt ? issueDependencies(v) : null
  } catch {
    return null
  }
}

function issueRowKey(repo: unknown, number: unknown): { repo: string; number: number } {
  if (!validIssueSlug(repo) || !validIssueNumber(number)) {
    throw new Error(`invalid issue key: ${String(repo)}#${String(number)}`)
  }
  return { repo, number }
}

function issueAttempt(startedAt: unknown): string {
  if (typeof startedAt !== 'string' || !ISO_INSTANT.test(startedAt)
    || new Date(Date.parse(startedAt)).toISOString() !== startedAt) {
    throw new Error(`invalid issue attempt time: ${String(startedAt)}`)
  }
  return startedAt
}

// A successful refresh. Returns false when the attempt rule refused it. The
// dependency section (slice 2) is written in the SAME statement, bound to this
// attempt's fetched_at; omitted, the column is cleared and reads as "unknown".
export function upsertIssueSnapshot(
  db: Database.Database,
  input: { repo: string; number: number; snapshot: IssueSnapshot; dependencies?: IssueDependencies; startedAt: string },
): boolean {
  const key = issueRowKey(input.repo, input.number)
  const startedAt = issueAttempt(input.startedAt)
  const snapshot = issueSnapshot(input.snapshot, key.number)
  if (!snapshot) throw new Error(`invalid issue snapshot for ${key.repo}#${key.number}`)
  const dependencies = input.dependencies === undefined ? null : issueDependencies(input.dependencies)
  if (input.dependencies !== undefined && !dependencies) throw new Error(`invalid issue dependencies for ${key.repo}#${key.number}`)
  const applied = db.prepare(
    `INSERT INTO issue_snapshots (repo, number, snapshot, dependencies, fetched_at, checked_at, error)
     VALUES (@repo, @number, @snapshot, @dependencies, @startedAt, @startedAt, NULL)
     ON CONFLICT(repo, number) DO UPDATE SET
       snapshot = excluded.snapshot, dependencies = excluded.dependencies,
       fetched_at = excluded.fetched_at, checked_at = excluded.checked_at,
       error = NULL, revision = issue_snapshots.revision + 1
     WHERE excluded.checked_at > issue_snapshots.checked_at`,
  ).run({
    ...key,
    snapshot: JSON.stringify(snapshot),
    dependencies: dependencies && JSON.stringify({ v: 1, fetched_at: startedAt, ...dependencies }),
    startedAt,
  }).changes > 0
  if (applied) pruneIssueSnapshots(db)
  return applied
}

// A failed refresh, under the same attempt rule. A soft failure (we could not
// ask) keeps the LAST ANSWER, whatever it was: the snapshot and its fetched_at,
// or a hard failure's code, so it only advances checked_at. Without that, the
// next offline tick would erase the evidence rule 6 (src/issue-graph.ts) needs,
// and titles GitHub refused would come back from other issues' older lists. A
// hard failure clears the snapshot and fetched_at IN THIS SAME STATEMENT: there
// is no moment at which GitHub has said no and the cached titles are readable.
// Clearing fetched_at alone unbinds the dependency section (an older build's
// hard failure does only that); this build clears the column as well.
export function recordIssueFailure(
  db: Database.Database,
  input: { repo: string; number: number; error: IssueError; startedAt: string },
): boolean {
  const key = issueRowKey(input.repo, input.number)
  const startedAt = issueAttempt(input.startedAt)
  const hard = ISSUE_HARD_ERRORS.has(input.error)
  if (!hard && !ISSUE_SOFT_ERRORS.has(input.error)) throw new Error(`invalid issue error: ${String(input.error)}`)
  return db.prepare(
    `INSERT INTO issue_snapshots (repo, number, checked_at, error) VALUES (@repo, @number, @startedAt, @error)
     ON CONFLICT(repo, number) DO UPDATE SET
       checked_at = excluded.checked_at,
       error = CASE WHEN @hard = 0 AND issue_snapshots.error IN (${ISSUE_HARD_ERRORS_SQL})
                    THEN issue_snapshots.error ELSE excluded.error END,
       snapshot = CASE WHEN @hard = 1 THEN NULL ELSE issue_snapshots.snapshot END,
       dependencies = CASE WHEN @hard = 1 THEN NULL ELSE issue_snapshots.dependencies END,
       fetched_at = CASE WHEN @hard = 1 THEN NULL ELSE issue_snapshots.fetched_at END,
       revision = issue_snapshots.revision + 1
     WHERE excluded.checked_at > issue_snapshots.checked_at`,
  ).run({ ...key, startedAt, error: input.error, hard: hard ? 1 : 0 }).changes > 0
}

// Every row, parsed. Invalid JSON or an invalid shape (including a snapshot
// version this build does not know) reads as "no snapshot" and never throws:
// one corrupt row must not take down /api/issues. The dependency section reads
// the same way, and only beside a readable snapshot: nothing else anchors it.
export function listIssueSnapshots(db: Database.Database): IssueSnapshotRow[] {
  const rows = db.prepare(
    `SELECT repo, number, provider, snapshot, dependencies, fetched_at, checked_at, error, revision
       FROM issue_snapshots ORDER BY repo, number`,
  ).all() as Array<Omit<IssueSnapshotRow, 'snapshot' | 'dependencies' | 'failure'> & {
    snapshot: string | null
    dependencies: string | null
  }>
  return rows.map((r) => {
    const snapshot = readIssueSnapshot(r.snapshot, r.number)
    return {
      ...r,
      snapshot,
      dependencies: snapshot ? readIssueDependencies(r.dependencies, r.fetched_at) : null,
      failure: r.error === null ? null : ISSUE_HARD_ERRORS.has(r.error) ? 'hard' : 'soft',
    }
  })
}

// What can link an issue: open items, active and archived plans, and the rows
// of those plans that carry an explicit link (PR2). Closed items are History
// and keep their plain chip.
export function listIssueEntities(db: Database.Database): IssueEntity[] {
  const rows = db.prepare(
    `SELECT 'item' AS kind, id, project, 0 AS archived, repo, stream, head_repo, issue_ref,
            NULL AS issue_pin_repo, NULL AS issue_pin_number, NULL AS issue_repo, NULL AS issue_number,
            COALESCE(updated_at, created_at) AS updated_at
       FROM items WHERE status = 'open'
     UNION ALL
     SELECT 'plan' AS kind, id, project, status = 'archived' AS archived, repo, stream, head_repo, issue_ref,
            issue_pin_repo, issue_pin_number, NULL AS issue_repo, NULL AS issue_number,
            updated_at
       FROM boards WHERE status IN ('active', 'archived')
     UNION ALL
     SELECT 'row' AS kind, r.id, b.project, b.status = 'archived' AS archived, NULL AS repo, '' AS stream,
            NULL AS head_repo, NULL AS issue_ref, NULL AS issue_pin_repo, NULL AS issue_pin_number,
            r.issue_repo, r.issue_number, r.updated_at
       FROM board_rows r JOIN boards b ON b.id = r.board_id
      WHERE b.status IN ('active', 'archived') AND r.issue_number IS NOT NULL
     ORDER BY kind, id`,
  ).all() as Array<Omit<IssueEntity, 'archived' | 'project_closed'> & { archived: number }>
  const closed = new Set(closedProjects(db))
  return rows.map((r) => ({ ...r, archived: r.archived === 1, project_closed: closed.has(r.project) }))
}

export function pruneIssueSnapshots(db: Database.Database, opts: { nowMs?: number } = {}): void {
  const cutoff = new Date((opts.nowMs ?? Date.now()) - ISSUE_TTL_DAYS * 24 * 60 * 60000).toISOString()
  db.prepare(`DELETE FROM issue_snapshots WHERE checked_at < ?`).run(cutoff)
}

// ── refresh claims: one viewer fetches a key at a time (issue #103 PR1b) ────
//
// The attempt rule orders writes but cannot stop two viewers sharing this hub
// (a checkout viewer and the packaged app) from fetching the same batch. A
// claim is a lease: the viewer that holds a live one is the only one that asks
// GitHub about that key until it completes or the lease expires (§5.5). Both
// calls are ONE .immediate() transaction: a deferred one would read before it
// writes, and two viewers could both see a key unclaimed.

/** One queued key, with the checked_at its caller saw (null: never fetched). */
export interface IssueClaimKey {
  repo: string
  number: number
  checked_at: string | null
}

export interface IssueRefreshResult {
  repo: string
  number: number
  /** start time of the attempt, for the attempt rule */
  startedAt: string
  snapshot?: IssueSnapshot
  /** slice 2: the dependency section fetched with `snapshot` */
  dependencies?: IssueDependencies
  error?: IssueError
}

// Walks the caller's queue in order, skipping a key another viewer holds or
// refreshed since the caller read it, and leases up to `limit` keys.
export function claimIssueRefresh(
  db: Database.Database,
  input: { owner: string; queue: IssueClaimKey[]; limit: number; leaseMs: number; nowMs: number },
): IssueClaimKey[] {
  if (typeof input.owner !== 'string' || !input.owner) throw new Error('invalid claim owner')
  const now = new Date(input.nowMs).toISOString()
  const leaseUntil = new Date(input.nowMs + input.leaseMs).toISOString()
  const held = db.prepare(`SELECT 1 FROM issue_refresh_claims WHERE repo = ? AND number = ?`).pluck()
  const checked = db.prepare(`SELECT checked_at FROM issue_snapshots WHERE repo = ? AND number = ?`).pluck()
  const lease = db.prepare(`INSERT INTO issue_refresh_claims (repo, number, owner, lease_until) VALUES (?, ?, ?, ?)`)
  return db.transaction((): IssueClaimKey[] => {
    db.prepare(`DELETE FROM issue_refresh_claims WHERE lease_until <= ?`).run(now)
    const claimed: IssueClaimKey[] = []
    const seen = new Set<string>()
    for (const entry of input.queue) {
      if (claimed.length >= input.limit) break
      if (!validIssueSlug(entry.repo) || !validIssueNumber(entry.number)) continue
      const id = `${entry.repo.toLowerCase()}#${entry.number}`
      if (seen.has(id)) continue
      seen.add(id)
      if (held.get(entry.repo, entry.number) !== undefined) continue
      const stored = (checked.get(entry.repo, entry.number) as string | undefined) ?? null
      if (stored !== entry.checked_at) continue
      lease.run(entry.repo, entry.number, input.owner, leaseUntil)
      claimed.push({ repo: entry.repo, number: entry.number, checked_at: entry.checked_at })
    }
    return claimed
  }).immediate()
}

// Applies each result under the attempt rule, then releases this owner's
// leases on those keys (never another owner's). A snapshot that fails the v1
// validator, or a dependency section that fails its own, is recorded as a soft
// gh-failed instead: one throw would roll back the whole batch, and the same
// keys would be claimed and refetched every tick.
// Returns how many results the attempt rule applied.
export function completeIssueRefresh(
  db: Database.Database,
  input: {
    owner: string
    results: IssueRefreshResult[]
    /** told of each result the validators refused, which was recorded as gh-failed */
    onInvalid?: (key: { repo: string; number: number }) => void
  },
): number {
  const release = db.prepare(`DELETE FROM issue_refresh_claims WHERE repo = ? AND number = ? AND owner = ?`)
  return db.transaction((): number => {
    let applied = 0
    for (const r of input.results) {
      if (!validIssueSlug(r.repo) || !validIssueNumber(r.number)) continue
      let done: boolean
      if (r.snapshot) {
        const valid = issueSnapshot(r.snapshot, r.number) !== null
          && (r.dependencies === undefined || issueDependencies(r.dependencies) !== null)
        if (!valid) input.onInvalid?.({ repo: r.repo, number: r.number })
        done = valid
          ? upsertIssueSnapshot(db, {
              repo: r.repo, number: r.number, snapshot: r.snapshot, dependencies: r.dependencies, startedAt: r.startedAt,
            })
          : recordIssueFailure(db, { repo: r.repo, number: r.number, error: 'gh-failed', startedAt: r.startedAt })
      } else {
        done = recordIssueFailure(db, { repo: r.repo, number: r.number, error: r.error ?? 'gh-failed', startedAt: r.startedAt })
      }
      if (done) applied++
      release.run(r.repo, r.number, input.owner)
    }
    return applied
  }).immediate()
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
