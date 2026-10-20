-- Frozen schema of an Agent Inbox v1.3.1 hub (issue #103, PR1a).
--
-- sqlite_master of a database created by v1.3.1 openDb() (src/store.ts is
-- byte-identical between tag v1.3.1 and c27792c6), rewritten to the
-- IF NOT EXISTS forms runMigrations() executes, so the same text both creates
-- a v1.3.1-shaped hub and replays an old process opening a migrated one.
-- test/mixed-version.test.ts runs it on a second connection. Never edit it
-- to follow a newer schema: it stands for the process that cannot change.

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
    , context TEXT NOT NULL DEFAULT '', options TEXT, reply TEXT, reply_context TEXT, replied_at TEXT, reply_seen_at TEXT, reply_source TEXT, session TEXT, repo TEXT, issue_ref INTEGER, head_repo TEXT);

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
      last_read_at TEXT, repo TEXT, issue_ref INTEGER, head_repo TEXT,
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
      position INTEGER NOT NULL, handled_at TEXT, handled_seen_at TEXT, handled_seen_by TEXT, annotation_seen_at TEXT, annotation_seen_by TEXT,
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
    , idle INTEGER NOT NULL DEFAULT 0, last_call_at TEXT, server_version TEXT, server_source TEXT);

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

CREATE TRIGGER IF NOT EXISTS increment_item_response_revision
    AFTER UPDATE OF reply, reply_context, reply_kind, reply_source, replied_at, annotation ON items
    BEGIN
      UPDATE items SET response_revision = OLD.response_revision + 1 WHERE id = NEW.id;
    END;

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
