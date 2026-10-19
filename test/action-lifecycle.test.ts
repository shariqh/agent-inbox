import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  advanceBoardRow,
  annotateBoardRow,
  archiveBoard,
  clearRowHandled,
  getBoard,
  insertItem,
  listBoards,
  listItems,
  listPendingRows,
  listUnansweredBoardRows,
  markAnnotationDelivered,
  markReplySeen,
  markRowHandled,
  openDb,
  replyItem,
  resolveItem,
  snoozeBoardRow,
  snoozeItem,
  stopBoardRowWatch,
  stopItemWatch,
  getItem,
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

const HOLD_WRITE_LOCK = `
  import Database from 'better-sqlite3'
  const db = new Database(process.argv[1])
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.exec('BEGIN IMMEDIATE')
  db.prepare(\`
    INSERT INTO items (
      id, project, stream, agent, kind, title, detail, next_step, impact,
      next_after, status, created_at, updated_at
    ) VALUES (
      'during-migration', 'p', '', 'holder', 'note', 'concurrent write',
      '', '', '', '', 'open', '2026-08-07T00:00:00.000Z',
      '2026-08-07T00:00:00.000Z'
    )
  \`).run()
  process.stdout.write('locked\\n')
  setTimeout(() => {
    db.exec('COMMIT')
    db.close()
  }, 350)
`

describe('action lifecycle storage', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('waits for a concurrent writer before migration reads and preserves its commit', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'migration-lock-')), 'inbox.db')
    openDb(path).close()

    const holder = spawn(process.execPath, ['--input-type=module', '-e', HOLD_WRITE_LOCK, path], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    holder.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const exit = new Promise<number | null>((resolve) => holder.once('close', resolve))
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once('data', (chunk) => {
        if (String(chunk) === 'locked\n') resolve()
        else reject(new Error(`unexpected lock-holder output: ${String(chunk)}`))
      })
      holder.once('error', reject)
      holder.once('close', (code) => reject(new Error(`lock holder exited before acquiring the lock (${code}): ${stderr}`)))
    })

    const started = Date.now()
    const migrated = openDb(path)
    const waitedMs = Date.now() - started
    expect(waitedMs).toBeGreaterThanOrEqual(150)
    expect(listItems(migrated).map((item) => item.id)).toContain('during-migration')
    migrated.close()
    expect(await exit, stderr).toBe(0)
  }, 10000)

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

  // #160: annotateBoardRow stores the TRIMMED text, so a cleared note is '' with
  // no kind — still unanswered for listUnansweredBoardRows and attention.js, which
  // therefore keep offering Snooze on the row. The snooze write must agree.
  it('snoozes and wakes a blocked row whose annotation the human cleared', () => {
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [{ label: 'Task', status: 'blocked' }],
    })
    let board = getBoard(db, 'p', 'B')!
    const rowId = board.rows[0]!.id
    expect(annotateBoardRow(db, rowId, 'Merge it', 'answer', board.rows[0]!.revision, board.revision)).toBe(true)
    board = getBoard(db, 'p', 'B')!
    expect(annotateBoardRow(db, rowId, '', 'answer', board.rows[0]!.revision, board.revision)).toBe(true)
    board = getBoard(db, 'p', 'B')!
    let row = board.rows[0]!
    expect(row).toMatchObject({ annotation: '', annotation_kind: null, handled_at: null })
    expect(listUnansweredBoardRows(db, 'p').map((candidate) => candidate.id)).toEqual([rowId])

    const until = new Date(Date.now() + 60 * 60_000).toISOString()
    expect(snoozeBoardRow(db, rowId, until, row.revision, board.revision)).toBe(true)
    board = getBoard(db, 'p', 'B')!
    row = board.rows[0]!
    expect(row.snoozed_until).toBe(until)

    expect(snoozeBoardRow(db, rowId, null, row.revision, board.revision)).toBe(true)
    expect(getBoard(db, 'p', 'B')!.rows[0]!.snoozed_until).toBeNull()
  })

  it('still refuses to snooze an answered, handled, unblocked or stale row', () => {
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'B',
      rows: [
        { label: 'Answered', status: 'blocked' },
        { label: 'Kind only', status: 'blocked' },
        { label: 'Handled', status: 'blocked' },
        { label: 'Not blocked', status: 'partial' },
        { label: 'Stale', status: 'blocked' },
      ],
    })
    const current = (label: string) => {
      const board = getBoard(db, 'p', 'B')!
      return { board, row: board.rows.find((candidate) => candidate.label === label)! }
    }
    const until = new Date(Date.now() + 60 * 60_000).toISOString()
    const snooze = (label: string) => {
      const { board, row } = current(label)
      return snoozeBoardRow(db, row.id, until, row.revision, board.revision)
    }

    annotateBoardRow(db, current('Answered').row.id, 'Merge it')
    expect(snooze('Answered')).toBe(false)

    // Shapes annotateBoardRow cannot write, built directly so each guard is pinned
    // on its own: a legacy answer from before annotation_kind existed (text, NULL
    // kind) and a kind without text. Raw SQL is allowed HERE, in a test; store.ts
    // remains the only door for production code.
    const setResponse = (label: string, annotation: string, kind: string | null) => {
      db.prepare(`UPDATE board_rows SET annotation = ?, annotation_kind = ? WHERE id = ?`)
        .run(annotation, kind, current(label).row.id)
    }
    setResponse('Answered', 'Merge it', null)
    expect(snooze('Answered')).toBe(false)
    setResponse('Kind only', '', 'clarify')
    expect(snooze('Kind only')).toBe(false)

    // The rest carry a cleared annotation, so only their other guard can refuse.
    for (const label of ['Handled', 'Not blocked', 'Stale']) annotateBoardRow(db, current(label).row.id, '')
    expect(markRowHandled(db, current('Handled').row.id)).toBe(true)
    expect(snooze('Handled')).toBe(false)
    expect(snooze('Not blocked')).toBe(false)

    const { board, row } = current('Stale')
    expect(snoozeBoardRow(db, row.id, until, row.revision - 1, board.revision)).toBe(false)
    expect(snoozeBoardRow(db, row.id, until, row.revision, board.revision - 1)).toBe(false)
    expect(current('Stale').row.snoozed_until).toBeNull()
    expect(snooze('Stale')).toBe(true)

    expect(getBoard(db, 'p', 'B')!.rows.map((candidate) => [candidate.label, candidate.snoozed_until])).toEqual([
      ['Answered', null], ['Kind only', null], ['Handled', null], ['Not blocked', null], ['Stale', until],
    ])
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

  // #158: a row's revision is the CAS token the native notification pins, so a
  // re-send that only MOVES a row must not version it. The board revision still
  // records the move, because it is what protects a full-table snapshot.
  describe('position-only re-sends (#158)', () => {
    const DEPLOY = {
      label: 'Deploy',
      status: 'blocked' as const,
      note: 'The release candidate is ready.',
      next_step: 'Choose the deploy window.',
      action_owner: 'decision' as const,
      impact: 'Schedules the release.',
      options: [{ label: 'Today', recommended: true }, { label: 'Tomorrow' }],
    }
    const UPLOAD = {
      label: 'Upload',
      status: 'blocked' as const,
      note: 'The build is notarized.',
      next_step: 'Upload the build to the store.',
      action_owner: 'task' as const,
      impact: 'Required before release.',
    }
    const tick = () => new Promise((resolve) => setTimeout(resolve, 2))
    const board = () => getBoard(db, 'p', 'B')!
    const labels = () => board().rows.map((row) => row.label)

    it('moves unchanged rows without a row revision or content stamp, but versions the board', async () => {
      upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'B', rows: [DEPLOY, UPLOAD] })
      const original = board()
      const [deploy, upload] = original.rows
      await tick()

      writeBoard(db, {
        project: 'p', stream: '', agent: 'a', title: 'B',
        expectedVersion: original.revision,
        rows: [
          { label: 'Build', status: 'partial', note: 'CI is running.' },
          { label: 'Deploy', revision: deploy!.revision, status: 'blocked' },
          { label: 'Upload', revision: upload!.revision, status: 'blocked' },
        ],
      })
      const inserted = board()
      expect(labels()).toEqual(['Build', 'Deploy', 'Upload'])
      expect(inserted.revision).toBeGreaterThan(original.revision)
      for (const before of [deploy!, upload!]) {
        expect(inserted.rows.find((row) => row.id === before.id)).toMatchObject({
          revision: before.revision,
          updated_at: before.updated_at,
          action_version: before.action_version,
        })
      }
      await tick()

      // A pure swap changes nothing but order: only the board version records it.
      writeBoard(db, {
        project: 'p', stream: '', agent: 'a', title: 'B',
        expectedVersion: inserted.revision,
        rows: [...inserted.rows].reverse().map((row) => ({ label: row.label, revision: row.revision, status: row.status })),
      })
      const swapped = board()
      expect(labels()).toEqual(['Upload', 'Deploy', 'Build'])
      expect(swapped.revision).toBeGreaterThan(inserted.revision)
      for (const before of inserted.rows) {
        expect(swapped.rows.find((row) => row.id === before.id)).toMatchObject({
          revision: before.revision,
          updated_at: before.updated_at,
        })
      }

      // Every row revision in the pre-swap snapshot is still current, so the
      // board version is the only thing that refuses it.
      expect(() => writeBoard(db, {
        project: 'p', stream: '', agent: 'a', title: 'B',
        expectedVersion: inserted.revision,
        rows: inserted.rows.map((row) => ({ label: row.label, revision: row.revision, status: row.status })),
      })).toThrow(/board version mismatch/)
      expect(board()).toEqual(swapped)
    })

    it('still versions a moved row whose content changed', async () => {
      upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'B', rows: [DEPLOY, UPLOAD] })
      const original = board()
      const [deploy, upload] = original.rows
      await tick()

      writeBoard(db, {
        project: 'p', stream: '', agent: 'a', title: 'B',
        expectedVersion: original.revision,
        rows: [
          { label: 'Upload', revision: upload!.revision, status: 'blocked' },
          { label: 'Deploy', revision: deploy!.revision, status: 'blocked', note: 'The window moved to Friday.' },
        ],
      })
      const after = board()
      const changed = after.rows.find((row) => row.id === deploy!.id)!
      expect(changed).toMatchObject({ position: 1, note: 'The window moved to Friday.', revision: deploy!.revision + 1 })
      expect(changed.updated_at > deploy!.updated_at).toBe(true)
      expect(after.rows.find((row) => row.id === upload!.id)).toMatchObject({
        position: 0,
        revision: upload!.revision,
        updated_at: upload!.updated_at,
      })
      expect(after.revision).toBeGreaterThan(original.revision)
    })

    it('refuses human writes pinned to the pre-move board revision, even with a current row revision', () => {
      upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'B', rows: [DEPLOY, UPLOAD] })
      const original = board()
      const [deploy, upload] = original.rows
      writeBoard(db, {
        project: 'p', stream: '', agent: 'a', title: 'B',
        expectedVersion: original.revision,
        rows: [
          { label: 'Upload', revision: upload!.revision, status: 'blocked' },
          { label: 'Deploy', revision: deploy!.revision, status: 'blocked' },
        ],
      })
      const moved = board()
      const current = (id: string) => moved.rows.find((row) => row.id === id)!.revision
      expect(moved.revision).toBeGreaterThan(original.revision)

      expect(annotateBoardRow(db, deploy!.id, 'Today', 'answer', current(deploy!.id), original.revision)).toBe(false)
      expect(snoozeBoardRow(db, deploy!.id, '2099-01-01T00:00:00.000Z', current(deploy!.id), original.revision)).toBe(false)
      expect(markRowHandled(db, upload!.id, current(upload!.id), original.revision)).toBe(false)
      expect(clearRowHandled(db, upload!.id, current(upload!.id), original.revision)).toBe(false)
      expect(board()).toEqual(moved)

      // A response captured before the move needs only a refreshed board token.
      expect(annotateBoardRow(db, deploy!.id, 'Today', 'answer', deploy!.revision, moved.revision)).toBe(true)
      expect(markRowHandled(db, upload!.id, upload!.revision, board().revision)).toBe(true)
      expect(board().rows.map((row) => [row.label, row.annotation, Boolean(row.handled_at)])).toEqual([
        ['Upload', null, true],
        ['Deploy', 'Today', false],
      ])
    })

    it('lets board_row and board_advance use an unchanged row revision after a sibling move', () => {
      upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'B', rows: [DEPLOY, UPLOAD] })
      const original = board()
      const [deploy, upload] = original.rows
      writeBoard(db, {
        project: 'p', stream: '', agent: 'a', title: 'B',
        expectedVersion: original.revision,
        rows: [
          { label: 'Build', status: 'partial', note: 'CI is running.' },
          { label: 'Deploy', revision: deploy!.revision, status: 'blocked' },
          { label: 'Upload', revision: upload!.revision, status: 'blocked' },
        ],
      })

      writeBoardRow(db, {
        project: 'p', stream: '', agent: 'a', title: 'B', label: 'Deploy',
        expectedBoardVersion: board().revision,
        expectedRevision: deploy!.revision,
        impact: 'Customers are waiting on the fix.',
      })
      expect(board().rows.find((row) => row.id === deploy!.id)).toMatchObject({
        impact: 'Customers are waiting on the fix.',
        revision: deploy!.revision + 1,
      })

      expect(advanceBoardRow(db, {
        project: 'p',
        title: 'B',
        label: 'Upload',
        expectedBoardVersion: board().revision,
        expectedRevision: upload!.revision,
        note: 'The build is uploaded.',
        next_step: 'Confirm the store listing.',
        action_owner: 'task',
        impact: 'Required before release.',
      })).toEqual({ ok: true, action_version: upload!.action_version + 1, revision: upload!.revision + 1 })
      expect(labels()).toEqual(['Build', 'Deploy', 'Upload'])
    })
  })
})

// Issue #217 — "I'll take a while": the human tells a Copilot answer watcher to
// stop waiting, for good or until a time. Human-owned like annotation and
// handled_at, but NOT content: it never moves updated_at or either revision, so
// it neither re-announces the ask nor invalidates an agent's snapshot.
describe('watch stop (#217)', () => {
  let db: Database.Database
  const T0 = Date.parse('2026-10-19T12:00:00.000Z')
  const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()
  const clock = (minutes: number) => vi.setSystemTime(T0 + minutes * 60_000)

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    clock(0)
    db = freshDb()
  })
  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  const question = () => insertItem(db, { project: 'p', stream: '', agent: 'copilot', kind: 'question', title: 'Choose' })
  const blocked = (label = 'Upload') => {
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'copilot', title: 'B',
      rows: [...(getBoard(db, 'p', 'B')?.rows.filter((row) => row.label !== label)
        .map(({ label: other, status }) => ({ label: other, status })) ?? []),
      { label, status: 'blocked', note: 'Upload the build.', next_step: 'Upload it.', action_owner: 'task', impact: 'Ships it.' }],
    })
    return current(label)
  }
  const current = (label = 'Upload') => {
    const board = getBoard(db, 'p', 'B')!
    return { board, row: board.rows.find((row) => row.label === label)! }
  }
  const stopRow = (until: string | null, label = 'Upload') => {
    const { board, row } = current(label)
    return stopBoardRowWatch(db, row.id, until, row.revision, board.revision)
  }

  // A v1.3.x MCP process sharing the database after the upgrade: origin/main's
  // beginNewRowAction and advanceBoardRow statements, verbatim, from a second
  // connection whose code knows nothing of the #217 columns. Raw SQL is allowed
  // HERE, in a test, to stand in for that older writer.
  const olderServerAdvances = (rowId: string) => {
    const older = new Database(db.name)
    try {
      const row = older.prepare('SELECT action_version FROM board_rows WHERE id = ?').get(rowId) as { action_version: number }
      const now = new Date().toISOString()
      older.prepare(`
        UPDATE board_rows
           SET note = '', next_step = '', action_owner = NULL, impact = '', next_after = '', options = NULL,
               annotation = NULL, annotation_kind = NULL, annotated_at = NULL, annotation_seen_at = NULL,
               annotation_seen_by = NULL, handled_at = NULL, handled_seen_at = NULL, handled_seen_by = NULL,
               snoozed_until = NULL, outcome = '', outcome_at = NULL, action_started_at = ?, action_version = ?,
               revision = revision + 1, history = ?, updated_at = ?
         WHERE id = ?`).run(now, row.action_version + 1, '[]', now, rowId)
      older.prepare(`UPDATE board_rows SET status = 'blocked', note = ?, next_step = ?, action_owner = ?, impact = ?,
                       next_after = '', options = NULL, updated_at = ? WHERE id = ?`)
        .run('The next build is ready.', 'Install it.', 'task', 'Ships it.', now, rowId)
    } finally {
      older.close()
    }
  }

  it('an older server starting the next action carries over neither the stop nor the asker', () => {
    blocked()
    clock(5)
    expect(stopRow(null)).toBe(true)
    expect(current().row).toMatchObject({ action_agent: 'copilot', watch_stopped_at: at(5) })
    clock(10)
    olderServerAdvances(current().row.id)
    expect(current().row).toMatchObject({
      action_version: 2, watch_stopped_at: null, watch_stopped_until: null, action_agent: null,
    })
  })

  it('a write that leaves the action version alone keeps the stop and the asker', () => {
    blocked()
    expect(stopRow(at(60))).toBe(true)
    db.prepare('UPDATE board_rows SET action_version = action_version').run()
    expect(current().row).toMatchObject({ watch_stopped_until: at(60), action_agent: 'copilot' })
  })

  // The control the human sees must follow whoever raised THIS ask: a board's
  // agent is only its last writer, and only some agents run a watcher.
  it('records who raised each row action, whichever agent last wrote the board', () => {
    const ask = (label: string) => ({ label, status: 'blocked' as const, note: 'Needed.', next_step: 'Do it.', action_owner: 'task' as const, impact: 'Ships it.' })
    upsertBoard(db, { project: 'p', stream: '', agent: 'claude-code', title: 'B', rows: [ask('Deploy')] })
    expect(current('Deploy').row.action_agent).toBe('claude-code')

    updateBoardRow(db, { project: 'p', stream: '', agent: 'copilot', title: 'B', label: 'Docs', status: 'tracked' })
    expect(getBoard(db, 'p', 'B')!.agent).toBe('copilot')
    expect(current('Deploy').row.action_agent).toBe('claude-code')
    expect(current('Docs').row.action_agent).toBe('copilot')

    let { board, row } = current('Deploy')
    expect(advanceBoardRow(db, {
      project: 'p', title: 'B', label: 'Deploy', agent: 'copilot',
      expectedBoardVersion: board.revision, expectedRevision: row.revision,
      note: 'The fix is ready.', next_step: 'Deploy it.', action_owner: 'task', impact: 'Ships it.',
    })).toMatchObject({ ok: true })
    expect(current('Deploy').row.action_agent).toBe('copilot')

    updateBoardRow(db, { project: 'p', stream: '', agent: 'claude-code', title: 'B', label: 'Deploy', impact: 'Ships 1.4.' })
    expect(current('Deploy').row.action_agent).toBe('copilot')

    updateBoardRow(db, { project: 'p', stream: '', agent: 'claude-code', title: 'B', label: 'Deploy', status: 'partial' })
    upsertBoard(db, { project: 'p', stream: '', agent: 'claude-code', title: 'B', rows: [ask('Deploy'), { label: 'Docs', status: 'tracked' }] })
    expect(current('Deploy').row).toMatchObject({ action_version: 3, action_agent: 'claude-code' })

    ;({ board, row } = current('Deploy'))
    advanceBoardRow(db, {
      project: 'p', title: 'B', label: 'Deploy',
      expectedBoardVersion: board.revision, expectedRevision: row.revision,
      note: 'One more step.', next_step: 'Confirm it.', action_owner: 'task', impact: 'Ships it.',
    })
    expect(current('Deploy').row.action_agent, 'an advance that names no agent records none').toBeNull()
  })

  it('records who raised a question; one raised by an older server has no asker', () => {
    expect(getItem(db, question())!.action_agent).toBe('copilot')
    db.prepare(`INSERT INTO items (id, project, stream, agent, kind, title, status, created_at, updated_at)
                VALUES ('older', 'p', '', 'copilot', 'question', 'Raised by 1.3', 'open', ?, ?)`).run(at(0), at(0))
    expect(getItem(db, 'older')!.action_agent).toBeNull()
  })

  it('stops an open question for good or until a time, without touching content or its response version', () => {
    const id = question()
    clock(5)
    const before = getItem(db, id)!
    expect(stopItemWatch(db, id, at(120))).toBe(true)
    expect(getItem(db, id)).toEqual({ ...before, watch_stopped_at: at(5), watch_stopped_until: at(120) })

    clock(6)
    expect(stopItemWatch(db, id, at(180)), 'a deferral can still be moved').toBe(true)
    expect(stopItemWatch(db, id, null)).toBe(true)
    expect(getItem(db, id)).toMatchObject({ watch_stopped_at: at(6), watch_stopped_until: null })
    expect(getItem(db, id)!.updated_at).toBe(before.updated_at)
    expect(getItem(db, id)!.response_revision).toBe(before.response_revision)

    // A stop for good has already ended the watcher; a later deferral cannot revive it.
    clock(7)
    expect(stopItemWatch(db, id, at(240))).toBe(false)
    expect(stopItemWatch(db, id, null)).toBe(false)
    expect(getItem(db, id)).toMatchObject({ watch_stopped_at: at(6), watch_stopped_until: null })
  })

  it('refuses to stop an answered, closed or informational item', () => {
    const answered = question()
    replyItem(db, answered, 'Ship it')
    const resolved = question()
    resolveItem(db, resolved)
    const note = insertItem(db, { project: 'p', stream: '', agent: 'copilot', kind: 'note', title: 'FYI' })
    for (const id of [answered, resolved, note, 'missing']) expect(stopItemWatch(db, id, null), id).toBe(false)
    expect(listItems(db).every((item) => item.watch_stopped_at === null)).toBe(true)
  })

  it('pins a row stop to the row and board revisions without bumping either', () => {
    const { board, row } = blocked()
    clock(5)
    expect(stopBoardRowWatch(db, row.id, null, row.revision - 1, board.revision)).toBe(false)
    expect(stopBoardRowWatch(db, row.id, null, row.revision, board.revision - 1)).toBe(false)
    expect(current().row.watch_stopped_at).toBeNull()

    expect(stopBoardRowWatch(db, row.id, at(60), row.revision, board.revision)).toBe(true)
    const after = current()
    expect(after.row).toEqual({ ...row, watch_stopped_at: at(5), watch_stopped_until: at(60) })
    expect(after.board.revision).toBe(board.revision)
    // Unbumped pins stay valid for the human's next write and the agent's next upsert.
    expect(stopRow(null)).toBe(true)
    expect(current().row).toMatchObject({ watch_stopped_until: null, revision: row.revision })
    expect(stopRow(at(90)), 'a stop for good is final').toBe(false)
  })

  it('refuses to stop an answered, handled, unblocked or archived row', () => {
    blocked('Answered')
    blocked('Handled')
    blocked('Done later')
    annotateBoardRow(db, current('Answered').row.id, 'Uploaded')
    markRowHandled(db, current('Handled').row.id)
    updateBoardRow(db, { project: 'p', stream: '', agent: 'copilot', title: 'B', label: 'Done later', status: 'partial' })
    for (const label of ['Answered', 'Handled', 'Done later']) expect(stopRow(null, label), label).toBe(false)

    const { board } = current('Answered')
    archiveBoard(db, board.id, board.revision)
    const archived = listBoards(db, { status: 'archived' })[0]!
    const row = archived.rows.find((candidate) => candidate.label === 'Answered')!
    expect(stopBoardRowWatch(db, row.id, null, row.revision, archived.revision)).toBe(false)
  })

  it('survives routine agent upserts and row edits of the same blocked ask', () => {
    blocked()
    expect(stopRow(at(60))).toBe(true)
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'copilot', title: 'B',
      rows: [{ label: 'Upload', status: 'blocked', note: 'Upload the signed build.' }],
    })
    updateBoardRow(db, { project: 'p', stream: '', agent: 'copilot', title: 'B', label: 'Upload', impact: 'Ships 1.4.' })
    expect(current().row).toMatchObject({
      note: 'Upload the signed build.', impact: 'Ships 1.4.', watch_stopped_until: at(60), action_version: 1,
    })
    expect(current().row.watch_stopped_at).not.toBeNull()
  })

  it('is cleared by a new ask: board_advance and an ordinary re-block', () => {
    blocked()
    expect(stopRow(null)).toBe(true)
    const { board, row } = current()
    expect(advanceBoardRow(db, {
      project: 'p', title: 'B', label: 'Upload', expectedBoardVersion: board.revision, expectedRevision: row.revision,
      note: 'The notarized build is ready.', next_step: 'Upload it.', action_owner: 'task', impact: 'Ships it.',
    })).toMatchObject({ ok: true, action_version: 2 })
    expect(current().row).toMatchObject({ action_version: 2, watch_stopped_at: null, watch_stopped_until: null })

    expect(stopRow(null)).toBe(true)
    updateBoardRow(db, { project: 'p', stream: '', agent: 'copilot', title: 'B', label: 'Upload', status: 'partial' })
    updateBoardRow(db, {
      project: 'p', stream: '', agent: 'copilot', title: 'B', label: 'Upload', status: 'blocked',
      note: 'One more upload.', next_step: 'Upload it.', action_owner: 'task', impact: 'Ships it.',
    })
    expect(current().row).toMatchObject({ action_version: 3, watch_stopped_at: null, watch_stopped_until: null })

    expect(stopRow(at(30))).toBe(true)
    upsertBoard(db, { project: 'p', stream: '', agent: 'copilot', title: 'B', rows: [{ label: 'Upload', status: 'done' }] })
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'copilot', title: 'B',
      rows: [{ label: 'Upload', status: 'blocked', note: 'Again.', next_step: 'Upload it.', action_owner: 'task', impact: 'Ships it.' }],
    })
    expect(current().row).toMatchObject({ action_version: 4, watch_stopped_at: null, watch_stopped_until: null })
  })
})
