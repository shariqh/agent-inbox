import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  advanceBoardRow,
  annotateBoardRow,
  archiveBoard,
  getBoard,
  insertItem,
  listBoards,
  listItems,
  listPendingRows,
  markAnnotationDelivered,
  markReplySeen,
  openDb,
  replyItem,
  resolveItem,
  snoozeBoardRow,
  snoozeItem,
  updateBoardRow as writeBoardRow,
  upsertBoard as writeBoard,
} from '../src/store.js'

function freshDb(): Database.Database {
  return openDb(join(mkdtempSync(join(tmpdir(), 'lifecycle-')), 'inbox.db'))
}

function boardState(db: Database.Database, project: string, title: string) {
  return [...listBoards(db), ...listBoards(db, { status: 'archived' })]
    .find((board) => board.project === project && board.title === title)
}

function upsertBoard(db: Database.Database, input: Parameters<typeof writeBoard>[1]) {
  const existing = boardState(db, input.project, input.title)
  return writeBoard(db, {
    ...input,
    expectedVersion: input.expectedVersion ?? existing?.revision,
    rows: input.rows.map((row) => {
      const current = existing?.rows.find((candidate) => candidate.label === row.label)
      return current && row.revision === undefined
        ? { ...row, revision: current.revision }
        : row
    }),
  })
}

function updateBoardRow(db: Database.Database, input: Parameters<typeof writeBoardRow>[1]) {
  const existing = boardState(db, input.project, input.title)
  const row = existing?.rows.find((candidate) => candidate.label === input.label)
  return writeBoardRow(db, {
    ...input,
    expectedBoardVersion: input.expectedBoardVersion ?? existing?.revision,
    expectedRevision: input.expectedRevision ?? row?.revision,
  })
}

describe('action lifecycle storage', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('backfills legacy item/row timestamps from their existing creation records', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lifecycle-migration-')), 'inbox.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'unknown', kind TEXT NOT NULL, title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '', next_step TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open', annotation TEXT, created_at TEXT NOT NULL,
        resolved_at TEXT, context TEXT NOT NULL DEFAULT '', options TEXT, reply TEXT,
        reply_context TEXT, replied_at TEXT, reply_seen_at TEXT, reply_source TEXT,
        session TEXT, repo TEXT, issue_ref INTEGER
      );
      CREATE TABLE boards (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'unknown', title TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_read_at TEXT,
        repo TEXT, issue_ref INTEGER, UNIQUE(project, title)
      );
      CREATE TABLE board_rows (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', next_step TEXT NOT NULL DEFAULT '', options TEXT,
        context TEXT NOT NULL DEFAULT '', annotation TEXT, annotated_at TEXT,
        annotation_seen_at TEXT, annotation_seen_by TEXT, handled_at TEXT,
        handled_seen_at TEXT, handled_seen_by TEXT, position INTEGER NOT NULL,
        UNIQUE(board_id, label)
      );
      INSERT INTO items (
        id, project, kind, title, created_at
      ) VALUES ('i1', 'p', 'question', 'Legacy item', '2026-08-01T10:00:00.000Z');
      INSERT INTO boards (
        id, project, title, status, created_at, updated_at
      ) VALUES ('b1', 'p', 'Legacy board', 'active', '2026-08-01T09:00:00.000Z', '2026-08-02T09:00:00.000Z');
      INSERT INTO board_rows (
        id, board_id, label, status, position
      ) VALUES ('r1', 'b1', 'Legacy row', 'tracked', 0);
    `)
    legacy.close()

    const migrated = openDb(path)
    expect(listItems(migrated)[0]!.updated_at).toBe('2026-08-01T10:00:00.000Z')
    const legacyBoard = getBoard(migrated, 'p', 'Legacy board')!
    expect(legacyBoard.revision).toBe(1)
    const row = legacyBoard.rows[0]!
    expect(row.created_at).toBe('2026-08-01T09:00:00.000Z')
    expect(row.updated_at).toBe('2026-08-02T09:00:00.000Z')
    expect(row.action_started_at).toBe('2026-08-01T09:00:00.000Z')
    expect(row.action_version).toBe(1)
    expect(row.revision).toBe(1)
    expect(row.history).toEqual([])
    migrated.close()
  })

  it('round-trips ownership, impact, next-after and content change stamps', () => {
    const itemId = insertItem(db, {
      project: 'p',
      stream: 'main',
      agent: 'claude',
      kind: 'question',
      title: 'Merge PR #42?',
      detail: 'All review gates are green.',
      next_step: 'Choose whether to merge.',
      action_owner: 'approval',
      impact: 'Unblocks the implementation PR.',
      next_after: 'The agent starts implementation.',
      options: [{ label: 'Merge', recommended: true }, { label: 'Hold' }],
    })
    const item = listItems(db).find((candidate) => candidate.id === itemId)!
    expect(item).toMatchObject({
      action_owner: 'approval',
      impact: 'Unblocks the implementation PR.',
      next_after: 'The agent starts implementation.',
      outcome: '',
      outcome_at: null,
      snoozed_until: null,
      reply_kind: null,
    })
    expect(item.updated_at).toBe(item.created_at)

    const { boardId } = upsertBoard(db, {
      project: 'p',
      stream: 'main',
      agent: 'claude',
      title: 'Launch',
      rows: [{
        label: 'Recruit partners',
        status: 'blocked',
        note: 'The outreach kit is ready.',
        next_step: 'Choose the tracker.',
        action_owner: 'decision',
        impact: 'Required before outreach starts.',
        next_after: 'Send the first three messages.',
        options: [{ label: 'People Pipeline', recommended: true }, { label: 'Scratchpad' }],
      }],
    })
    const row = getBoard(db, 'p', 'Launch')!.rows[0]!
    expect(row).toMatchObject({
      action_owner: 'decision',
      impact: 'Required before outreach starts.',
      next_after: 'Send the first three messages.',
      action_version: 1,
      history: [],
      outcome: '',
      outcome_at: null,
      snoozed_until: null,
      annotation_kind: null,
    })
    expect(row.created_at).toMatch(/^\d{4}-/)
    expect(row.updated_at).toBe(row.created_at)
    expect(row.action_started_at).toBe(row.created_at)
    expect(boardId).toBeTruthy()
  })

  it('records clarification/decline kinds and never treats delivery as content change', async () => {
    const itemId = insertItem(db, {
      project: 'p', stream: '', agent: 'a', kind: 'question', title: 'Choose',
    })
    const beforeItem = listItems(db)[0]!.updated_at
    await new Promise((resolve) => setTimeout(resolve, 2))
    replyItem(db, itemId, 'Please clarify the exact decision.', undefined, 'clarify')
    let item = listItems(db)[0]!
    expect(item.reply_kind).toBe('clarify')
    expect(item.updated_at > beforeItem).toBe(true)
    const itemChangedAt = item.updated_at
    markReplySeen(db, itemId, item.replied_at)
    item = listItems(db)[0]!
    expect(item.updated_at).toBe(itemChangedAt)

    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{ label: 'Decide', status: 'blocked' }],
    })
    let row = getBoard(db, 'p', 'B')!.rows[0]!
    const beforeRow = row.updated_at
    await new Promise((resolve) => setTimeout(resolve, 2))
    annotateBoardRow(db, row.id, 'Declined: not this quarter.', 'decline')
    row = getBoard(db, 'p', 'B')!.rows[0]!
    expect(row.annotation_kind).toBe('decline')
    expect(row.updated_at > beforeRow).toBe(true)
    const rowChangedAt = row.updated_at
    markAnnotationDelivered(db, row.id, row.annotated_at, 'claude-code')
    expect(getBoard(db, 'p', 'B')!.rows[0]!.updated_at).toBe(rowChangedAt)
  })

  it('snoozes and wakes items and rows as human-owned content state', () => {
    const itemId = insertItem(db, {
      project: 'p', stream: '', agent: 'a', kind: 'question', title: 'Choose',
    })
    const until = new Date(Date.now() + 60 * 60_000).toISOString()
    expect(snoozeItem(db, itemId, until)).toBe(true)
    expect(listItems(db)[0]!.snoozed_until).toBe(until)
    expect(snoozeItem(db, itemId, null)).toBe(true)
    expect(listItems(db)[0]!.snoozed_until).toBeNull()

    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{ label: 'Task', status: 'blocked' }],
    })
    const rowId = getBoard(db, 'p', 'B')!.rows[0]!.id
    expect(snoozeBoardRow(db, rowId, until)).toBe(true)
    expect(getBoard(db, 'p', 'B')!.rows[0]!.snoozed_until).toBe(until)
    expect(listPendingRows(db, 'p')[0]).toMatchObject({
      row_id: rowId,
      snoozed_until: until,
    })
    expect(snoozeBoardRow(db, rowId, null)).toBe(true)
    expect(getBoard(db, 'p', 'B')!.rows[0]!.snoozed_until).toBeNull()
  })

  it('records outcomes when agents acknowledge items and rows', () => {
    const itemId = insertItem(db, {
      project: 'p', stream: '', agent: 'a', kind: 'question', title: 'Ship?',
    })
    resolveItem(db, itemId, 'Merged PR #42 and dispatched implementation.')
    expect(listItems(db)[0]).toMatchObject({
      status: 'resolved',
      outcome: 'Merged PR #42 and dispatched implementation.',
    })
    expect(listItems(db)[0]!.outcome_at).toMatch(/^\d{4}-/)

    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{ label: 'Ship', status: 'blocked' }],
    })
    updateBoardRow(db, {
      project: 'p', stream: '', agent: 'a', title: 'B', label: 'Ship',
      status: 'done', outcome: 'Release shipped successfully.',
    })
    expect(getBoard(db, 'p', 'B')).toBeUndefined()
    const archived = db.prepare(`SELECT outcome, outcome_at FROM board_rows WHERE label = 'Ship'`).get() as {
      outcome: string
      outcome_at: string
    }
    expect(archived.outcome).toBe('Release shipped successfully.')
    expect(archived.outcome_at).toMatch(/^\d{4}-/)
  })

  it('does not rewrite outcome timestamps when the same result is replayed', async () => {
    const itemId = insertItem(db, {
      project: 'p', stream: '', agent: 'a', kind: 'question', title: 'Ship?',
    })
    resolveItem(db, itemId, 'Shipped.')
    const firstItem = listItems(db)[0]!
    await new Promise((resolve) => setTimeout(resolve, 2))
    resolveItem(db, itemId, 'Shipped.')
    const secondItem = listItems(db)[0]!
    expect(secondItem.outcome_at).toBe(firstItem.outcome_at)
    expect(secondItem.updated_at).toBe(firstItem.updated_at)

    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{ label: 'Ship', status: 'blocked' }],
    })
    updateBoardRow(db, {
      project: 'p', stream: '', agent: 'a', title: 'B', label: 'Ship',
      status: 'partial', outcome: 'Canary shipped.',
    })
    let row = getBoard(db, 'p', 'B')!.rows[0]!
    const firstOutcomeAt = row.outcome_at
    const firstUpdatedAt = row.updated_at
    await new Promise((resolve) => setTimeout(resolve, 2))
    updateBoardRow(db, {
      project: 'p', stream: '', agent: 'a', title: 'B', label: 'Ship',
      expectedRevision: row.revision,
      outcome: 'Canary shipped.',
    })
    row = getBoard(db, 'p', 'B')!.rows[0]!
    expect(row.outcome_at).toBe(firstOutcomeAt)
    expect(row.updated_at).toBe(firstUpdatedAt)
  })

  it('advances the same row atomically, archives the prior action, and rejects stale versions', () => {
    upsertBoard(db, {
      project: 'p',
      stream: 'main',
      agent: 'claude',
      title: 'Launch',
      rows: [{
        label: 'Outreach',
        status: 'blocked',
        note: 'The kit is ready.',
        next_step: 'Choose the tracker.',
        action_owner: 'decision',
        impact: 'Required before outreach starts.',
        next_after: 'Send the first three messages.',
        options: [{ label: 'People Pipeline', recommended: true }, { label: 'Scratchpad' }],
        context: 'Long-lived market proof context.',
      }],
    })
    let board = getBoard(db, 'p', 'Launch')!
    let row = board.rows[0]!
    annotateBoardRow(db, row.id, 'People Pipeline', 'answer')
    snoozeBoardRow(db, row.id, '2026-08-06T12:00:00.000Z')
    board = getBoard(db, 'p', 'Launch')!
    row = board.rows[0]!

    const advanced = advanceBoardRow(db, {
      project: 'p',
      title: 'Launch',
      label: 'Outreach',
      expectedBoardVersion: board.revision,
      expectedRevision: row.revision,
      note: 'The tracker is selected.',
      next_step: 'Send the first three personalized messages.',
      action_owner: 'task',
      impact: 'Starts the design-partner evidence loop.',
      next_after: 'Review replies and schedule interviews.',
      options: [],
    })
    expect(advanced).toEqual({ ok: true, action_version: 2, revision: row.revision + 1 })

    board = getBoard(db, 'p', 'Launch')!
    row = board.rows[0]!
    expect(row).toMatchObject({
      status: 'blocked',
      action_version: 2,
      note: 'The tracker is selected.',
      action_owner: 'task',
      annotation: null,
      annotation_kind: null,
      annotation_seen_at: null,
      handled_at: null,
      snoozed_until: null,
      outcome: '',
      context: 'Long-lived market proof context.',
    })
    expect(row.options).toBeNull()
    expect(row.history).toHaveLength(1)
    expect(row.history[0]).toMatchObject({
      version: 1,
      note: 'The kit is ready.',
      response_kind: 'answer',
      response: 'People Pipeline',
      action_owner: 'decision',
    })

    const stale = advanceBoardRow(db, {
      project: 'p',
      title: 'Launch',
      label: 'Outreach',
      expectedBoardVersion: board.revision,
      expectedRevision: 1,
      note: 'Stale overwrite',
      next_step: 'Do not write this.',
      action_owner: 'task',
      impact: 'None',
      options: [],
    })
    expect(stale).toEqual({ ok: false, reason: 'version_mismatch', revision: row.revision })
    expect(getBoard(db, 'p', 'Launch')!.rows[0]!.note).toBe('The tracker is selected.')
  })

  it('uses the same archive-and-reset path for an ordinary nonblocked → blocked transition', () => {
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{
        label: 'Deploy',
        status: 'blocked',
        note: 'Choose the window.',
        next_step: 'Pick today or tomorrow.',
        action_owner: 'decision',
        impact: 'Schedules the release.',
        options: [{ label: 'Today' }, { label: 'Tomorrow' }],
      }],
    })
    const rowId = getBoard(db, 'p', 'B')!.rows[0]!.id
    annotateBoardRow(db, rowId, 'Tomorrow', 'answer')
    updateBoardRow(db, {
      project: 'p', stream: '', agent: 'a', title: 'B', label: 'Deploy',
      status: 'partial', outcome: 'Tomorrow selected.',
    })
    updateBoardRow(db, {
      project: 'p', stream: '', agent: 'a', title: 'B', label: 'Deploy',
      status: 'blocked',
      note: 'The release candidate is ready.',
      next_step: 'Upload the notarized build.',
      action_owner: 'task',
      impact: 'Required before tomorrow’s release.',
      options: [],
    })
    const next = getBoard(db, 'p', 'B')!.rows[0]!
    expect(next.action_version).toBe(2)
    expect(next.annotation).toBeNull()
    expect(next.outcome).toBe('')
    expect(next.history).toHaveLength(1)
    expect(next.history[0]).toMatchObject({ response: 'Tomorrow', outcome: 'Tomorrow selected.' })
  })

  it('rejects stale agent and human writes after a row advances', () => {
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{
        label: 'Deploy',
        status: 'blocked',
        note: 'Choose.',
        next_step: 'Choose today or tomorrow.',
        action_owner: 'decision',
        impact: 'Schedules release.',
        options: [{ label: 'Today' }, { label: 'Tomorrow' }],
      }],
    })
    const board = getBoard(db, 'p', 'B')!
    const row = board.rows[0]!
    advanceBoardRow(db, {
      project: 'p',
      title: 'B',
      label: 'Deploy',
      expectedBoardVersion: board.revision,
      expectedRevision: 1,
      note: 'Window chosen.',
      next_step: 'Upload the build.',
      action_owner: 'task',
      impact: 'Required for release.',
    })

    expect(() => upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{
        label: 'Deploy',
        status: 'blocked',
        revision: 1,
        note: 'Stale action.',
        next_step: 'Do the old thing.',
        action_owner: 'task',
        impact: 'Wrong.',
      }],
    })).toThrow(/revision/)
    expect(annotateBoardRow(db, row.id, 'Stale answer', 'answer', 1)).toBe(false)
    expect(getBoard(db, 'p', 'B')!.rows[0]).toMatchObject({
      action_version: 2,
      note: 'Window chosen.',
      annotation: null,
    })
  })

  it('rejects a second browser response that targets the same stale row revision', () => {
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{ label: 'Choose', status: 'blocked' }],
    })
    const board = getBoard(db, 'p', 'B')!
    const row = board.rows[0]!
    expect(annotateBoardRow(db, row.id, 'First answer', 'answer', row.revision, board.revision)).toBe(true)
    expect(annotateBoardRow(db, row.id, 'Stale second answer', 'answer', row.revision, board.revision)).toBe(false)
    expect(getBoard(db, 'p', 'B')!.rows[0]!.annotation).toBe('First answer')
  })

  it('pins archive state to the board revision in both directions', () => {
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{ label: 'One', status: 'tracked' }],
    })

    let board = getBoard(db, 'p', 'B')!
    const staleBoardRevision = board.revision
    updateBoardRow(db, {
      project: 'p', stream: '', agent: 'a', title: 'B', label: 'Two',
      status: 'tracked',
    })
    board = getBoard(db, 'p', 'B')!
    expect(archiveBoard(db, board.id, staleBoardRevision)).toBe(false)
    expect(getBoard(db, 'p', 'B')).toBeDefined()

    const preArchiveRevision = board.revision
    expect(archiveBoard(db, board.id, preArchiveRevision)).toBe(true)
    const archived = listBoards(db, { status: 'archived' }).find((candidate) => candidate.id === board.id)!
    expect(() => writeBoardRow(db, {
      project: 'p',
      stream: '',
      agent: 'a',
      title: 'B',
      label: 'One',
      expectedBoardVersion: preArchiveRevision,
      expectedRevision: archived.rows[0]!.revision,
      note: 'Stale overwrite',
    })).toThrow(/board version/)
    expect(listBoards(db, { status: 'archived' }).find((candidate) => candidate.id === board.id)).toBeDefined()
  })

  it('rejects duplicate row labels before mutating lifecycle state', () => {
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{ label: 'Deploy', status: 'tracked' }],
    })
    const before = getBoard(db, 'p', 'B')!
    expect(() => writeBoard(db, {
      project: 'p',
      stream: '',
      agent: 'a',
      title: 'B',
      expectedVersion: before.revision,
      rows: [
        { label: 'Deploy', revision: before.rows[0]!.revision, status: 'partial' },
        { label: 'Deploy', revision: before.rows[0]!.revision, status: 'blocked' },
      ],
    })).toThrow(/duplicate/)
    expect(getBoard(db, 'p', 'B')).toMatchObject({
      revision: before.revision,
      rows: [{ status: 'tracked', revision: before.rows[0]!.revision }],
    })
  })

  it('preserves an omitted note and invalidates a blocked snapshot after acknowledgement', () => {
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{
        label: 'Deploy',
        status: 'blocked',
        note: 'Keep this TLDR.',
        next_step: 'Choose.',
        action_owner: 'decision',
        impact: 'Schedules release.',
        options: [{ label: 'Go' }, { label: 'Hold' }],
      }],
    })
    let board = getBoard(db, 'p', 'B')!
    const staleRevision = board.rows[0]!.revision
    const boardRevision = board.revision
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{
        label: 'Deploy',
        revision: staleRevision,
        status: 'blocked',
      }],
    })
    board = getBoard(db, 'p', 'B')!
    expect(board.rows[0]!.note).toBe('Keep this TLDR.')
    expect(board.rows[0]!.revision).toBe(staleRevision)
    expect(board.revision).toBe(boardRevision)

    updateBoardRow(db, {
      project: 'p', stream: '', agent: 'a', title: 'B', label: 'Deploy',
      status: 'done', outcome: 'Acknowledged.',
    })
    board = [...listBoards(db), ...listBoards(db, { status: 'archived' })]
      .find((candidate) => candidate.title === 'B')!
    expect(board.rows[0]!.revision).toBeGreaterThan(staleRevision)
    expect(() => writeBoard(db, {
      project: 'p',
      stream: '',
      agent: 'a',
      title: 'B',
      expectedVersion: board.revision,
      rows: [{
        label: 'Deploy',
        revision: staleRevision,
        status: 'blocked',
        note: 'Stale reopen.',
        next_step: 'Do not reopen.',
        action_owner: 'task',
        impact: 'Wrong.',
      }],
    })).toThrow(/revision/)
  })
})
