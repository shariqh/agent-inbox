// Issue #103, PR1a: the issue_snapshots cache behind store.ts (§4.3, §4.4).
// Snapshots are written only by these tests for now; PR1b's poller is the
// production writer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  archiveBoard, closeProject, getBoard, insertItem, listBoards, listIssueEntities, listIssueSnapshots, listItems,
  openDb, pruneIssueSnapshots, recordIssueFailure, resolveItem, upsertBoard, upsertIssueSnapshot,
} from '../src/store.js'
import type { IssueSnapshot } from '../src/store.js'
import { at, facts, snapshot } from './issue-fixtures.js'

const FROZEN_V131 = readFileSync(new URL('./fixtures/v1.3.1-schema.sql', import.meta.url), 'utf8')
const KEY = { repo: 'shariqh/agent-inbox', number: 120 }
const SCOPE = { project: 'agent-inbox', stream: '120-ahp-input', agent: 'test' }

describe('issue snapshot store (issue #103)', () => {
  let dir: string
  let db: Database.Database

  beforeEach(() => {
    // Writes prune rows unchecked for 30 days by the wall clock, so the fixed
    // fixture evening must also be "now" or these tests would age out.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(at(60)))
    dir = mkdtempSync(join(tmpdir(), 'issue-store-'))
    db = openDb(join(dir, 'inbox.db'))
  })

  afterEach(() => {
    if (db.open) db.close()
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const child = snapshot('shariqh/agent-inbox#120', {
    ancestors: [facts('shariqh/agent-inbox#117', { children_total: 10, children_completed: 0 })],
  })

  function columns(connection: Database.Database, table: string) {
    return connection.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`).all(table)
  }

  describe('the additive migration', () => {
    it('creates issue_snapshots exactly as §4.3 declares it, keyed case-insensitively', () => {
      expect(columns(db, 'issue_snapshots')).toEqual([
        { name: 'repo', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
        { name: 'number', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 2 },
        { name: 'provider', type: 'TEXT', notnull: 1, dflt_value: "'github'", pk: 0 },
        { name: 'snapshot', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { name: 'fetched_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { name: 'checked_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { name: 'error', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { name: 'revision', type: 'INTEGER', notnull: 1, dflt_value: '1', pk: 0 },
      ])
      const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'issue_snapshots'`).get() as { sql: string }
      expect(ddl.sql).toMatch(/repo TEXT NOT NULL COLLATE NOCASE/)
    })

    it('migrates a v1.3.1-shaped hub additively: old tables, columns and rows are untouched', () => {
      const path = join(dir, 'v131.db')
      const old = new Database(path)
      old.exec(FROZEN_V131)
      old.prepare(`INSERT INTO items (id, project, stream, agent, kind, title, status, created_at, updated_at, repo, issue_ref)
        VALUES ('legacy', 'agent-inbox', '120-ahp-input', 'old', 'question', 'Still here?', 'open', ?, ?, 'shariqh/agent-inbox', 120)`)
        .run(at(1), at(1))
      const tables = (connection: Database.Database) => (connection.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'sqlite_sequence' ORDER BY name`,
      ).all() as Array<{ name: string }>).map((t) => t.name)
      const before = new Map(tables(old).map((name) => [name, columns(old, name)]))
      old.close()

      const migrated = openDb(path)
      try {
        expect(tables(migrated)).toEqual([...before.keys(), 'issue_refresh_claims', 'issue_snapshots'].sort())
        // PR1b appends one nullable column to source_links_by_head; nothing else changes
        const added: Record<string, unknown[]> = {
          source_links_by_head: [{ name: 'closing_refs', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }],
        }
        for (const [name, shape] of before) expect(columns(migrated, name), name).toEqual([...shape, ...(added[name] ?? [])])
        expect(listItems(migrated).map((item) => [item.id, item.title, item.issue_ref])).toEqual([['legacy', 'Still here?', 120]])
        expect(listIssueSnapshots(migrated)).toEqual([])
      } finally {
        migrated.close()
      }
      // a second open is a no-op
      const again = openDb(path)
      expect(columns(again, 'issue_snapshots')).toHaveLength(8)
      again.close()
    })
  })

  describe('writes', () => {
    it('stores a validated v1 snapshot and reads it back parsed, with failure null', () => {
      expect(upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(10) })).toBe(true)
      expect(listIssueSnapshots(db)).toEqual([{
        ...KEY, provider: 'github', snapshot: child, fetched_at: at(10), checked_at: at(10),
        error: null, failure: null, revision: 1,
      }])
    })

    it('keeps one row per repo-qualified key, whatever the casing', () => {
      upsertIssueSnapshot(db, { repo: 'Shariqh/Agent-Inbox', number: 120, snapshot: child, startedAt: at(10) })
      upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(20) })
      recordIssueFailure(db, { repo: 'SHARIQH/agent-INBOX', number: 120, error: 'offline', startedAt: at(30) })
      const rows = listIssueSnapshots(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ number: 120, fetched_at: at(20), checked_at: at(30), error: 'offline', revision: 3 })
    })

    it('never merges equal numbers from different repositories', () => {
      upsertIssueSnapshot(db, { repo: 'a/x', number: 5, snapshot: snapshot('a/x#5'), startedAt: at(1) })
      upsertIssueSnapshot(db, { repo: 'b/y', number: 5, snapshot: snapshot('b/y#5'), startedAt: at(1) })
      expect(listIssueSnapshots(db).map((r) => `${r.repo}#${r.number}`)).toEqual(['a/x#5', 'b/y#5'])
    })

    it('stores only the v1 fields it knows (normalized JSON)', () => {
      const noisy = {
        ...child,
        extra: 'dropped',
        issue: { ...child.issue, body: 'never cached', url: 'javascript:alert(1)' },
      } as unknown as IssueSnapshot
      upsertIssueSnapshot(db, { ...KEY, snapshot: noisy, startedAt: at(10) })
      const stored = db.prepare(`SELECT snapshot FROM issue_snapshots`).get() as { snapshot: string }
      expect(JSON.parse(stored.snapshot)).toEqual(child)
      expect(stored.snapshot).not.toMatch(/never cached|javascript|extra/)
    })

    const tooLong = 'x'.repeat(302)
    it.each<[string, (s: IssueSnapshot) => unknown]>([
      ['a version other than 1', (s) => ({ ...s, v: 2 })],
      ['a missing issue', (s) => ({ ...s, issue: undefined })],
      ['a different issue number than the key', (s) => ({ ...s, issue: { ...s.issue, number: 121 } })],
      ['an unsafe repository slug', (s) => ({ ...s, issue: { ...s.issue, repo: '../agent-inbox' } })],
      ['a dot segment in a slug', (s) => ({ ...s, ancestors: [facts('owner/..#117')] })],
      ['a non-integer number', (s) => ({ ...s, ancestors: [{ ...facts('a/b#1'), number: 1.5 }] })],
      ['a number beyond GraphQL Int', (s) => ({ ...s, ancestors: [{ ...facts('a/b#1'), number: 2 ** 31 }] })],
      ['an unknown state', (s) => ({ ...s, issue: { ...s.issue, state: 'MERGED' } })],
      ['an unknown state reason', (s) => ({ ...s, issue: { ...s.issue, state_reason: 'WONTFIX' } })],
      ['a non-string title', (s) => ({ ...s, issue: { ...s.issue, title: 42 } })],
      ['a title beyond the clip', (s) => ({ ...s, issue: { ...s.issue, title: tooLong } })],
      ['an unknown ancestors_end', (s) => ({ ...s, ancestors_end: 'bottom' })],
      ['a limit walk with no ancestor', (s) => ({ ...s, ancestors: [], ancestors_end: 'limit' })],
      ['more than eight ancestors', (s) => ({ ...s, ancestors: Array.from({ length: 9 }, (_, i) => facts(`a/b#${i + 1}`)) })],
      ['counts on a higher ancestor', (s) => ({
        ...s, ancestors: [facts('a/b#1'), facts('a/b#2', { children_total: 1, children_completed: 0 })],
      })],
      ['only one of the two counts', (s) => ({ ...s, ancestors: [{ ...facts('a/b#1'), children_total: 3 }] })],
      ['more completed than total', (s) => ({ ...s, ancestors: [facts('a/b#1', { children_total: 1, children_completed: 2 })] })],
      ['a negative count', (s) => ({ ...s, hierarchy: { status: 'ok', total: -1, completed: 0, truncated: false, children: [] } })],
      ['an unknown hierarchy status', (s) => ({ ...s, hierarchy: { status: 'partial' } })],
      ['a non-boolean truncated', (s) => ({ ...s, hierarchy: { status: 'ok', total: 0, completed: 0, truncated: 'no', children: [] } })],
      ['more than 100 children', (s) => ({
        ...s, hierarchy: {
          status: 'ok', total: 101, completed: 0, truncated: true,
          children: Array.from({ length: 101 }, (_, i) => facts(`a/b#${i + 1}`)),
        },
      })],
    ])('refuses %s on write and stores nothing', (_why, mutate) => {
      expect(() => upsertIssueSnapshot(db, { ...KEY, snapshot: mutate(child) as IssueSnapshot, startedAt: at(10) }))
        .toThrow(/invalid issue snapshot/)
      expect(listIssueSnapshots(db)).toEqual([])
    })

    it('accepts a title at the clip length and an unavailable hierarchy', () => {
      const clipped = snapshot('shariqh/agent-inbox#120', { issue: { title: `${'x'.repeat(300)}…` }, unavailable: true })
      expect(upsertIssueSnapshot(db, { ...KEY, snapshot: clipped, startedAt: at(10) })).toBe(true)
      expect(listIssueSnapshots(db)[0]!.snapshot).toEqual(clipped)
    })

    it.each([
      ['a slug', { repo: 'not a slug' }],
      ['a number', { number: 0 }],
      ['a startedAt', { startedAt: '2026-10-19 22:00' }],
      ['an error code', { error: 'teapot' }],
    ])('refuses an invalid %s', (_what, bad) => {
      expect(() => recordIssueFailure(db, { ...KEY, error: 'offline', startedAt: at(1), ...bad } as never)).toThrow()
      if (!('error' in bad)) {
        expect(() => upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(1), ...bad } as never)).toThrow()
      }
      expect(listIssueSnapshots(db)).toEqual([])
    })
  })

  describe('the attempt rule: the most recently started attempt wins', () => {
    it('ignores a late success from an older attempt', () => {
      upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(20) })
      const older = snapshot('shariqh/agent-inbox#120', { issue: { title: 'Stale title' } })
      expect(upsertIssueSnapshot(db, { ...KEY, snapshot: older, startedAt: at(10) })).toBe(false)
      expect(upsertIssueSnapshot(db, { ...KEY, snapshot: older, startedAt: at(20) })).toBe(false)
      expect(listIssueSnapshots(db)[0]).toMatchObject({ snapshot: child, fetched_at: at(20), revision: 1 })
    })

    it('ignores a late failure from an older attempt, soft or hard', () => {
      upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(20) })
      expect(recordIssueFailure(db, { ...KEY, error: 'offline', startedAt: at(10) })).toBe(false)
      expect(recordIssueFailure(db, { ...KEY, error: 'not-found', startedAt: at(19) })).toBe(false)
      expect(listIssueSnapshots(db)[0]).toMatchObject({ snapshot: child, error: null, checked_at: at(20) })
    })

    it('never lets an older success overwrite a newer failure', () => {
      recordIssueFailure(db, { ...KEY, error: 'forbidden', startedAt: at(20) })
      expect(upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(10) })).toBe(false)
      expect(listIssueSnapshots(db)[0]).toMatchObject({ snapshot: null, error: 'forbidden', failure: 'hard' })
    })

    it('bumps the revision on every applied write only', () => {
      upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(1) })
      recordIssueFailure(db, { ...KEY, error: 'offline', startedAt: at(2) })
      recordIssueFailure(db, { ...KEY, error: 'offline', startedAt: at(2) })
      upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(3) })
      expect(listIssueSnapshots(db)[0]!.revision).toBe(3)
    })
  })

  describe('failures', () => {
    it.each(['offline', 'rate-limit', 'gh-failed', 'no-gh', 'auth'] as const)(
      'a soft %s keeps the snapshot and its fetched_at, and ages checked_at',
      (error) => {
        upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(10) })
        expect(recordIssueFailure(db, { ...KEY, error, startedAt: at(20) })).toBe(true)
        expect(listIssueSnapshots(db)[0]).toMatchObject({
          snapshot: child, fetched_at: at(10), checked_at: at(20), error, failure: 'soft',
        })
      },
    )

    it.each(['not-found', 'forbidden', 'moved'] as const)(
      'a hard %s deletes the snapshot and fetched_at in the same statement',
      (error) => {
        upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(10) })
        const writes: string[] = []
        const prepare = db.prepare.bind(db)
        db.prepare = ((sql: string) => {
          if (/issue_snapshots/.test(sql) && !/^\s*SELECT/i.test(sql)) writes.push(sql)
          return prepare(sql)
        }) as typeof db.prepare
        try {
          expect(recordIssueFailure(db, { ...KEY, error, startedAt: at(20) })).toBe(true)
        } finally {
          db.prepare = prepare
        }
        expect(writes).toHaveLength(1)
        expect(listIssueSnapshots(db)[0]).toMatchObject({
          snapshot: null, fetched_at: null, checked_at: at(20), error, failure: 'hard',
        })
        const stored = db.prepare(`SELECT snapshot FROM issue_snapshots`).get() as { snapshot: string | null }
        expect(stored.snapshot).toBeNull()
      },
    )

    it('records a first failure for a key never fetched, and a later success revives it', () => {
      expect(recordIssueFailure(db, { ...KEY, error: 'not-found', startedAt: at(10) })).toBe(true)
      expect(listIssueSnapshots(db)[0]).toMatchObject({ snapshot: null, fetched_at: null, checked_at: at(10) })
      expect(upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(20) })).toBe(true)
      expect(listIssueSnapshots(db)[0]).toMatchObject({
        snapshot: child, fetched_at: at(20), checked_at: at(20), error: null, failure: null, revision: 2,
      })
    })

    it('a soft failure after a hard one keeps GitHub’s last answer and only advances checked_at', () => {
      upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(10) })
      recordIssueFailure(db, { ...KEY, error: 'forbidden', startedAt: at(20) })
      expect(recordIssueFailure(db, { ...KEY, error: 'offline', startedAt: at(30) })).toBe(true)
      expect(listIssueSnapshots(db)[0]).toMatchObject({
        snapshot: null, fetched_at: null, checked_at: at(30), error: 'forbidden', failure: 'hard', revision: 3,
      })
      // a newer hard answer still replaces the older one
      recordIssueFailure(db, { ...KEY, error: 'moved', startedAt: at(40) })
      expect(listIssueSnapshots(db)[0]).toMatchObject({ error: 'moved', checked_at: at(40) })
    })
  })

  describe('reads never throw', () => {
    // Deliberate fixture instrumentation: production writes go through
    // upsertIssueSnapshot, which can never store these.
    it.each([
      ['corrupt JSON', '{"v":1,'],
      ['a JSON scalar', '42'],
      ['a newer snapshot version', JSON.stringify({ ...child, v: 2 })],
      ['a shape that fails v1 validation', JSON.stringify({ ...child, ancestors_end: 'bottom' })],
      ['another issue number than the key', JSON.stringify({ ...child, issue: { ...child.issue, number: 7 } })],
    ])('reads %s as "no snapshot"', (_why, text) => {
      upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: at(10) })
      db.prepare(`UPDATE issue_snapshots SET snapshot = ?`).run(text)
      expect(listIssueSnapshots(db)).toEqual([{
        ...KEY, provider: 'github', snapshot: null, fetched_at: at(10), checked_at: at(10),
        error: null, failure: null, revision: 1,
      }])
    })

    it('classifies an error code it does not know as soft', () => {
      recordIssueFailure(db, { ...KEY, error: 'offline', startedAt: at(10) })
      db.prepare(`UPDATE issue_snapshots SET error = 'from-a-newer-build'`).run()
      expect(listIssueSnapshots(db)[0]).toMatchObject({ error: 'from-a-newer-build', failure: 'soft' })
    })
  })

  describe('pruning', () => {
    const DAY = 24 * 60 * 60_000

    it('deletes rows unchecked for 30 days, and keeps the boundary', () => {
      const now = Date.parse(at(60)) + 40 * DAY
      upsertIssueSnapshot(db, { repo: 'a/x', number: 1, snapshot: snapshot('a/x#1'), startedAt: new Date(now - 30 * DAY - 1).toISOString() })
      upsertIssueSnapshot(db, { repo: 'a/x', number: 2, snapshot: snapshot('a/x#2'), startedAt: new Date(now - 30 * DAY).toISOString() })
      recordIssueFailure(db, { repo: 'a/x', number: 3, error: 'no-gh', startedAt: new Date(now - 31 * DAY).toISOString() })
      pruneIssueSnapshots(db, { nowMs: now })
      expect(listIssueSnapshots(db).map((r) => r.number)).toEqual([2])
    })

    it('runs after every applied snapshot write', () => {
      vi.setSystemTime(Date.parse(at(0)) + 31 * DAY)
      recordIssueFailure(db, { repo: 'a/x', number: 1, error: 'offline', startedAt: at(0) })
      upsertIssueSnapshot(db, { ...KEY, snapshot: child, startedAt: new Date().toISOString() })
      expect(listIssueSnapshots(db).map((r) => r.number)).toEqual([120])
    })
  })

  describe('listIssueEntities', () => {
    it('lists open items and active and archived plans with their link fields and project state', () => {
      const open = insertItem(db, { ...SCOPE, kind: 'question', title: 'Q', repo: 'shariqh/agent-inbox', issue_ref: 120, head_repo: 'fork/agent-inbox' })
      const closedItem = insertItem(db, { ...SCOPE, kind: 'note', title: 'Done with', repo: 'shariqh/agent-inbox', issue_ref: 121 })
      resolveItem(db, closedItem)
      upsertBoard(db, { ...SCOPE, title: 'Active plan', rows: [{ label: 'Step', status: 'tracked' }], repo: 'shariqh/agent-inbox', issueRef: 117 })
      upsertBoard(db, { ...SCOPE, title: 'Old plan', rows: [], repo: 'shariqh/agent-inbox', issueRef: 119 })
      const old = getBoard(db, SCOPE.project, 'Old plan')!
      archiveBoard(db, old.id, old.revision)
      const elsewhere = insertItem(db, { ...SCOPE, project: 'retired', kind: 'question', title: 'Peek', repo: 'a/x', issue_ref: 5 })
      closeProject(db, 'retired')

      const active = listBoards(db)[0]!
      const archived = listBoards(db, { status: 'archived' })[0]!
      const item = listItems(db).find((i) => i.id === open)!
      expect(listIssueEntities(db)).toEqual(expect.arrayContaining([
        {
          kind: 'item', id: open, project: 'agent-inbox', project_closed: false, archived: false,
          repo: 'shariqh/agent-inbox', stream: '120-ahp-input', head_repo: 'fork/agent-inbox', issue_ref: 120,
          updated_at: item.updated_at,
        },
        {
          kind: 'plan', id: active.id, project: 'agent-inbox', project_closed: false, archived: false,
          repo: 'shariqh/agent-inbox', stream: '120-ahp-input', head_repo: null, issue_ref: 117, updated_at: active.updated_at,
        },
        {
          kind: 'plan', id: archived.id, project: 'agent-inbox', project_closed: false, archived: true,
          repo: 'shariqh/agent-inbox', stream: '120-ahp-input', head_repo: null, issue_ref: 119, updated_at: archived.updated_at,
        },
        expect.objectContaining({ kind: 'item', id: elsewhere, project: 'retired', project_closed: true, archived: false }),
      ]))
      expect(listIssueEntities(db)).toHaveLength(4)
      expect(listIssueEntities(db).map((e) => e.id)).not.toContain(closedItem)
    })

    it('follows the derived reopen of a closed project (#32)', () => {
      vi.setSystemTime(Date.parse(at(1)))
      insertItem(db, { ...SCOPE, kind: 'question', title: 'Before', repo: 'a/x', issue_ref: 5 })
      closeProject(db, SCOPE.project)
      expect(listIssueEntities(db).every((e) => e.project_closed)).toBe(true)
      vi.setSystemTime(Date.parse(at(2)))
      insertItem(db, { ...SCOPE, kind: 'question', title: 'After', repo: 'a/x', issue_ref: 6 })
      expect(listIssueEntities(db).every((e) => !e.project_closed)).toBe(true)
    })

    it('falls back to created_at for a legacy item with no updated_at', () => {
      const id = insertItem(db, { ...SCOPE, kind: 'question', title: 'Legacy', repo: 'a/x', issue_ref: 5 })
      db.prepare(`UPDATE items SET updated_at = NULL WHERE id = ?`).run(id)
      const created = listItems(db)[0]!.created_at
      expect(listIssueEntities(db)[0]).toMatchObject({ id, updated_at: created })
    })
  })
})
