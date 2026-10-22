// Issue #103, PR1b: refresh claims and leases (design §5.5). Two viewers can
// share one hub, so a key is fetched by at most one of them at a time, and a
// crashed viewer's lease expires on its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  claimIssueRefresh, completeIssueRefresh, listIssueSnapshots, openDb, recordIssueFailure, upsertIssueSnapshot,
} from '../src/store.js'
import { at, snapshot } from './issue-fixtures.js'
import { scratchDir } from './scratch.js'

const REPO = 'shariqh/agent-inbox'
const ROOT = new URL('..', import.meta.url).pathname
const FROZEN_V131 = readFileSync(new URL('./fixtures/v1.3.1-schema.sql', import.meta.url), 'utf8')
const ms = (minute: number) => Date.parse(at(minute))
const key = (number: number, checked_at: string | null = null) => ({ repo: REPO, number, checked_at })

describe('issue refresh claims (issue #103 PR1b)', () => {
  let dir: string
  let path: string
  let db: Database.Database
  const extra: Database.Database[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(ms(60))
    dir = scratchDir('issue-claims-')
    path = join(dir, 'inbox.db')
    db = openDb(path)
  })

  afterEach(() => {
    for (const connection of [db, ...extra.splice(0)]) if (connection.open) connection.close()
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  const claim = (connection: Database.Database, owner: string, queue: ReturnType<typeof key>[], nowMs = ms(60), limit = 10) =>
    claimIssueRefresh(connection, { owner, queue, limit, leaseMs: 60_000, nowMs }).map((k) => k.number)

  it('creates issue_refresh_claims as §4.3 declares it', () => {
    const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'issue_refresh_claims'`).get() as { sql: string }
    expect(ddl.sql).toMatch(/repo TEXT NOT NULL COLLATE NOCASE/)
    expect(ddl.sql).toMatch(/PRIMARY KEY \(repo, number\)/)
    expect((db.prepare(`SELECT name FROM pragma_table_info('issue_refresh_claims')`).all() as Array<{ name: string }>)
      .map((c) => c.name)).toEqual(['repo', 'number', 'owner', 'lease_until'])
  })

  it('claims up to the limit in queue order and skips keys another owner holds', () => {
    const queue = [key(3), key(1), key(2)]
    expect(claim(db, 'a', queue, ms(60), 2)).toEqual([3, 1])
    expect(claim(db, 'b', queue)).toEqual([2])
    expect(claim(db, 'b', queue)).toEqual([])
  })

  it('matches keys case-insensitively, as issue_snapshots does', () => {
    expect(claim(db, 'a', [{ repo: 'Shariqh/Agent-Inbox', number: 5, checked_at: null }])).toEqual([5])
    expect(claim(db, 'b', [key(5)])).toEqual([])
  })

  it('refuses a key whose checked_at moved since the caller read it', () => {
    upsertIssueSnapshot(db, { repo: REPO, number: 1, snapshot: snapshot(`${REPO}#1`), startedAt: at(10) })
    // another viewer refreshed #1 after this caller built its queue
    recordIssueFailure(db, { repo: REPO, number: 1, error: 'offline', startedAt: at(20) })
    expect(claim(db, 'a', [key(1, at(10)), key(2, at(5))])).toEqual([])
    expect(claim(db, 'a', [key(1, at(20)), key(2)])).toEqual([1, 2])
  })

  it('expires a crashed owner\'s lease after leaseMs, and not before', () => {
    expect(claim(db, 'crashed', [key(1)])).toEqual([1])
    expect(claim(db, 'b', [key(1)], ms(60) + 59_999)).toEqual([])
    expect(claim(db, 'b', [key(1)], ms(60) + 60_000)).toEqual([1])
  })

  it('completion applies results under the attempt rule and releases only its own leases', () => {
    expect(claim(db, 'a', [key(1), key(2)])).toEqual([1, 2])
    const applied = completeIssueRefresh(db, {
      owner: 'a',
      results: [
        { repo: REPO, number: 1, startedAt: at(60), snapshot: snapshot(`${REPO}#1`) },
        { repo: REPO, number: 2, startedAt: at(60), error: 'not-found' },
      ],
    })
    expect(applied).toBe(2)
    expect(listIssueSnapshots(db).map((r) => [r.number, r.error, r.fetched_at])).toEqual([[1, null, at(60)], [2, 'not-found', null]])
    // both released: another owner may claim them at once, given what it now sees
    expect(claim(db, 'b', [key(1, at(60)), key(2, at(60))])).toEqual([1, 2])
    // a completion never releases another owner's lease
    completeIssueRefresh(db, { owner: 'a', results: [{ repo: REPO, number: 1, startedAt: at(61), error: 'offline' }] })
    expect(claim(db, 'c', [key(1, at(61))])).toEqual([])
  })

  it('a late completion from an expired lease never overwrites the newer attempt', () => {
    expect(claim(db, 'slow', [key(1)], ms(60))).toEqual([1])
    // slow's lease expires; fast claims, fetches and completes first
    expect(claim(db, 'fast', [key(1)], ms(62))).toEqual([1])
    expect(completeIssueRefresh(db, {
      owner: 'fast', results: [{ repo: REPO, number: 1, startedAt: at(62), snapshot: snapshot(`${REPO}#1`, { issue: { title: 'new' } }) }],
    })).toBe(1)
    expect(completeIssueRefresh(db, {
      owner: 'slow', results: [{ repo: REPO, number: 1, startedAt: at(60), error: 'not-found' }],
    })).toBe(0)
    expect(listIssueSnapshots(db)[0]).toMatchObject({ error: null, snapshot: { issue: { title: 'new' } } })
  })

  it('a late success never overwrites a newer failure either', () => {
    expect(claim(db, 'slow', [key(1)], ms(60))).toEqual([1])
    expect(claim(db, 'fast', [key(1)], ms(62))).toEqual([1])
    completeIssueRefresh(db, { owner: 'fast', results: [{ repo: REPO, number: 1, startedAt: at(62), error: 'forbidden' }] })
    expect(completeIssueRefresh(db, {
      owner: 'slow', results: [{ repo: REPO, number: 1, startedAt: at(60), snapshot: snapshot(`${REPO}#1`) }],
    })).toBe(0)
    expect(listIssueSnapshots(db)[0]).toMatchObject({ error: 'forbidden', snapshot: null, checked_at: at(62) })
  })

  // A deferred transaction whose first statement writes behaves the same today,
  // so behaviour alone cannot tell them apart: pin the rule (CLAUDE.md, #154)
  // so that reordering the claim's reads ahead of its first write stays safe.
  it('claims and completions are IMMEDIATE transactions', () => {
    const src = readFileSync(join(ROOT, 'src', 'store.ts'), 'utf8')
    for (const name of ['claimIssueRefresh', 'completeIssueRefresh']) {
      const body = src.slice(src.indexOf(`export function ${name}(`))
      const end = body.indexOf('\n}\n')
      expect(body.slice(0, end), name).toMatch(/\}\)\.immediate\(\)$/)
    }
  })

  it('records an invalid snapshot as a soft gh-failed rather than rolling back the whole batch', () => {
    claim(db, 'a', [key(1), key(2)])
    const bad = { ...snapshot(`${REPO}#2`), v: 2 } as unknown as ReturnType<typeof snapshot>
    const invalid: Array<{ repo: string; number: number }> = []
    expect(completeIssueRefresh(db, {
      owner: 'a',
      results: [
        { repo: REPO, number: 1, startedAt: at(60), snapshot: snapshot(`${REPO}#1`) },
        { repo: REPO, number: 2, startedAt: at(60), snapshot: bad },
      ],
      onInvalid: (k) => invalid.push(k),
    })).toBe(2)
    // the downgrade is reported to the caller, which logs it (the store never does)
    expect(invalid).toEqual([{ repo: REPO, number: 2 }])
    expect(listIssueSnapshots(db).map((r) => [r.number, r.error])).toEqual([[1, null], [2, 'gh-failed']])
    expect(claim(db, 'b', [key(2, at(60))])).toEqual([2])
  })

  it('writes each dependency section with its snapshot, and records a refused section like a refused snapshot (slice 2 §5.3)', () => {
    claim(db, 'a', [key(1), key(2)])
    const none = { open: 0, total: 0, truncated: false, list: [] }
    const deps = { status: 'ok' as const, blocked_by: none, blocking: none }
    const invalid: Array<{ repo: string; number: number }> = []
    expect(completeIssueRefresh(db, {
      owner: 'a',
      results: [
        { repo: REPO, number: 1, startedAt: at(60), snapshot: snapshot(`${REPO}#1`), dependencies: deps },
        { repo: REPO, number: 2, startedAt: at(60), snapshot: snapshot(`${REPO}#2`), dependencies: { ...deps, blocking: { ...none, open: 1 } } },
      ],
      onInvalid: (k) => invalid.push(k),
    })).toBe(2)
    expect(invalid).toEqual([{ repo: REPO, number: 2 }])
    expect(listIssueSnapshots(db).map((r) => [r.number, r.error, r.snapshot !== null, r.dependencies]))
      .toEqual([[1, null, true, deps], [2, 'gh-failed', false, null]])
  })

  it('waits for, and then sees, another connection\'s uncommitted claim instead of claiming the same key', () => {
    const other = openDb(path)
    extra.push(other)
    other.pragma('busy_timeout = 50')
    db.exec('BEGIN IMMEDIATE')
    claimIssueRefresh(db, { owner: 'a', queue: [key(1)], limit: 10, leaseMs: 60_000, nowMs: ms(60) })
    // the competing claim cannot read a snapshot from before a's write: it is
    // one IMMEDIATE transaction, so it waits for the writer and then gives up
    expect(() => claimIssueRefresh(other, { owner: 'b', queue: [key(1)], limit: 10, leaseMs: 60_000, nowMs: ms(60) }))
      .toThrow(/busy|locked/i)
    db.exec('COMMIT')
    expect(claim(other, 'b', [key(1), key(2)])).toEqual([2])
  })

  it('two processes racing over one queue never claim the same key', async () => {
    const queue = Array.from({ length: 300 }, (_, i) => key(i + 1))
    const script = join(ROOT, 'test', 'fixtures', 'claim-race.ts')
    const start = String(Math.round(performance.timeOrigin + performance.now()) + 3_000) // real time: Date is faked here
    const race = (owner: string) => new Promise<number[]>((resolve, reject) => {
      const child = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), [script, path, owner, JSON.stringify(queue), start], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out) as number[]) : reject(new Error(err))))
    })
    const [a, b] = await Promise.all([race('a'), race('b')])
    // both really competed (each spun until a shared start time)
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
    expect(a.filter((n) => b.includes(n))).toEqual([])
    expect([...a, ...b].sort((x, y) => x - y)).toEqual(queue.map((k) => k.number))
  }, 30_000)

  it('a v1.3.1 process keeps working on a hub that has the claims table', () => {
    const old = new Database(path)
    extra.push(old)
    old.pragma('busy_timeout = 5000')
    old.transaction(() => old.exec(FROZEN_V131)).immediate()
    claim(db, 'a', [key(1)])
    old.prepare(`INSERT INTO projects (project, closed_at) VALUES ('x', ?)`).run(at(1))
    expect(old.prepare(`SELECT count(*) AS n FROM projects`).get()).toEqual({ n: 1 })
    expect(claim(db, 'b', [key(1)])).toEqual([])
  })
})
