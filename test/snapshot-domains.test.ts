// Issue #297: a write rebuilds only the conditional snapshots whose bytes it can
// change. Each snapshot names the store domains it is built from
// (SNAPSHOT_SOURCES in src/viewer.ts), and triggers move a domain's version with
// every committed write to the table or columns it covers (SNAPSHOT_DOMAINS in
// src/store.ts), whichever process makes it. These tests hold that mapping to
// the reads behind every route, so a table, column or read added later cannot
// go unmapped silently, and pin that presence, liveness and claim writes
// rebuild nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  SNAPSHOT_DOMAINS, annotateBoardRow, annotateItem, archiveBoard, claimHookWatch, claimIssueRefresh, closeProject,
  completeIssueRefresh, dismissItem, endActivity, getBoard, getItem, insertItem, markAnnotationDelivered,
  markBoardRead, markReplySeen, openDb, pinBoardRow, pinItem, readSnapshotState, recordActivityCall,
  recordIssueFailure, recordLinkFailure, releaseHookWatch, reopenProject, replyItem, resolveItem,
  setSourcePreview, touchActivity, updateBoardRow, upsertActivity, upsertBoard, upsertIssueSnapshot,
  upsertSourceLink,
} from '../src/store.js'
import { SNAPSHOT_SOURCES, createViewer } from '../src/viewer.js'
import { snapshot } from './issue-fixtures.js'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { SNAPSHOT_NAMES as SNAPSHOTS, SNAPSHOT_ROUTES as ROUTES, probe as probeOn, rebuiltBy as rebuiltOn, warm as warmOn } from './snapshot-probe.js'
import type { SnapshotName as Snapshot } from './snapshot-probe.js'

type Domain = keyof typeof SNAPSHOT_DOMAINS
type Hub = Database.Database
const DOMAINS: Record<Domain, { table: string; columns?: readonly string[]; restamped?: readonly string[] }> = SNAPSHOT_DOMAINS
const ITEMS: Snapshot[] = ['items', 'attention-items', 'history-items']
const PLANS: Snapshot[] = ['boards', 'attention-boards', 'archived-boards', 'archived-summary']

// Tables no snapshot reads, and why. Writes to them must never move a snapshot.
const UNREAD: Record<string, string> = {
  activity: 'presence and claims: /api/activity reads them fresh on every poll and is never retained',
  activity_spans: 'claim history: /api/activity/history validates on its own bytes (#185)',
  hook_watch_claims: "the Claude hook watcher's leases (#253)",
  issue_refresh_claims: "the issue poller's leases (#103 PR1b): listIssueSnapshots never reads them",
  item_reply_intents: "replyItem's replay ledger (#322)",
  source_links: 'the pre-#157 PR cache, kept only for older processes; nothing in this build reads it',
  snapshot_domains: 'the domain versions themselves',
  sqlite_sequence: "SQLite's AUTOINCREMENT counter for activity_spans",
}

// Every column, as of #297, of each table that some domain reads only in part.
// A new column fails here until someone decides, for each column domain of its
// table, whether that domain's snapshots read it. If one does, add the column to
// the domain: its triggers get new names, so existing hubs gain them too.
const REVIEWED_COLUMNS: Record<string, string[]> = {
  items: [
    'action_agent', 'action_owner', 'agent', 'annotated_at', 'annotation', 'annotation_seen_at',
    'annotation_seen_by', 'context', 'created_at', 'detail', 'head_repo', 'id', 'impact', 'issue_ref', 'kind',
    'next_after', 'next_step', 'options', 'outcome', 'outcome_at', 'pinned_at', 'project', 'replied_at',
    'reply', 'reply_context', 'reply_kind', 'reply_seen_at', 'reply_source', 'repo', 'repo_root',
    'resolved_at', 'response_revision', 'session', 'snoozed_until', 'status', 'stream', 'title', 'updated_at',
    'watch_stopped_at', 'watch_stopped_until',
  ],
  boards: [
    'agent', 'created_at', 'head_repo', 'id', 'issue_pin_number', 'issue_pin_repo', 'issue_ref', 'last_read_at',
    'project', 'repo', 'repo_root', 'revision', 'session', 'status', 'stream', 'title', 'updated_at',
  ],
  board_rows: [
    'action_agent', 'action_agent_version', 'action_owner', 'action_started_at', 'action_version', 'annotated_at',
    'annotation', 'annotation_kind', 'annotation_seen_at', 'annotation_seen_by', 'board_id', 'context',
    'created_at', 'handled_at', 'handled_seen_at', 'handled_seen_by', 'history', 'id', 'impact', 'issue_number',
    'issue_repo', 'label', 'next_after', 'next_step', 'note', 'options', 'outcome', 'outcome_at', 'pinned_at',
    'position', 'revision', 'snoozed_until', 'status', 'updated_at', 'waits_on', 'watch_stopped_at',
    'watch_stopped_until',
  ],
  source_links_by_head: [
    'branch', 'checked_at', 'checks', 'closing_refs', 'error', 'fetched_at', 'head_repo', 'issue_number',
    'issue_title', 'issue_url', 'pr_draft', 'pr_head_sha', 'pr_number', 'pr_state', 'pr_title', 'pr_url',
    'preview_deployment_id', 'preview_environment', 'preview_error', 'preview_updated_at', 'preview_url',
    'provider', 'repo', 'review_decision', 'revision', 'tldr',
  ],
}

const REPO = 'shariqh/agent-inbox'
const T0 = Date.parse('2026-10-20T12:00:00.000Z')
const key = (number: number) => `${REPO}#${number}`

// Every snapshot trigger a fresh hub gets, by name (see the test that pins it).
const TRIGGERS = readFileSync(new URL('./fixtures/snapshot-triggers.txt', import.meta.url), 'utf8').trim().split('\n')

let clock = T0
function tick(): string {
  clock += 1000
  vi.setSystemTime(clock)
  return new Date(clock).toISOString()
}

interface Fixture {
  asked: string
  answered: string
  release: string
  approve: string
}

// A hub built so that the columns each snapshot reads reach its bytes, which is
// what lets the generic test below catch a column left out of a domain:
//   - more closed items than /api/items pages, newer than the closed project's
//     outcome, so whether `beta` is closed (projects, and items or plans created
//     after its close) decides whether that outcome is on the page;
//   - cached previews on the branches an open item, an answered item pushed to
//     a fork, an active plan and the closed project sit on, and on one nothing
//     sits on, so /api/links keeps or drops each by listLinkTargets();
//   - issue identities from a plan's pin (#116), a PR's closing issue (#121,
//     #123), a branch issue (#130, #131) and row links (#122, #124), each the
//     only way its issue is reached, with a cached answer for each;
//   - rows in every table no snapshot reads.
// Not reachable here, and kept in their domains by reading the code: ids
// (never rewritten) and updated_at, which only ranks issues for the node cap.
function seed(db: Hub): Fixture {
  const alpha = { project: 'alpha', agent: 'claude-code', session: 'mcp-1' }
  const asked = insertItem(db, { ...alpha, stream: '120-work', kind: 'question', title: 'Ship it?', repo: REPO, issue_ref: 120, context: 'Background.' })
  tick()
  const answered = insertItem(db, {
    ...alpha, stream: '121-work', kind: 'question', title: 'Which pool?', repo: REPO, issue_ref: 129, head_repo: 'fork/agent-inbox',
  })
  tick()
  replyItem(db, answered, 'tank')
  tick()
  insertItem(db, { ...alpha, stream: '', kind: 'note', title: 'Assumed Node 24' })
  tick()
  insertItem(db, { ...alpha, stream: '', kind: 'done', title: 'Shipped 1.7' })
  tick()
  const merged = insertItem(db, { ...alpha, stream: '119-work', kind: 'question', title: 'Merge?', repo: REPO, issue_ref: 119 })
  tick()
  resolveItem(db, merged, 'Merged.')
  tick()
  dismissItem(db, insertItem(db, { ...alpha, stream: '', kind: 'note', title: 'Dropped' }))
  tick()
  const intent = insertItem(db, { ...alpha, stream: '', kind: 'question', title: 'Replayable?' })
  replyItem(db, intent, 'Yes', undefined, 'answer', { clientId: 'window-1', sequence: 1, actionId: 'send-1' })

  // beta: everything here predates its close, so the project stays closed
  const beta = { project: 'beta', agent: 'copilot', session: 'mcp-2' }
  tick()
  insertItem(db, { ...beta, stream: '130-beta', kind: 'question', title: 'Beta ask', repo: REPO, issue_ref: 130 })
  tick()
  resolveItem(db, insertItem(db, { ...beta, stream: '', kind: 'question', title: 'Beta done' }), 'Beta outcome.')
  tick()
  upsertBoard(db, {
    ...beta, stream: '131-beta', title: 'Beta plan', repo: REPO, issueRef: 131,
    rows: [{ label: 'Wait', status: 'blocked', note: 'Waiting.', next_step: 'Do it.', action_owner: 'task', impact: 'Unblocks beta.' }],
  })
  tick()
  closeProject(db, 'beta')
  // newer closed history than beta's outcome, and more of it than one page holds
  for (let i = 0; i < 55; i++) {
    tick()
    resolveItem(db, insertItem(db, { ...alpha, stream: '', kind: 'note', title: `Closed note ${i}` }))
  }

  tick()
  upsertBoard(db, {
    ...alpha, stream: '117-umbrella', title: 'Release', repo: REPO, issueRef: 117, issuePin: { repo: REPO, number: 116 },
    rows: [
      {
        label: 'Approve', status: 'blocked', note: 'Ready.', next_step: 'Approve it.', action_owner: 'approval', impact: 'Ships.',
        options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }], issue: { repo: REPO, number: 120 },
      },
      { label: 'Build', status: 'done', issue: { repo: REPO, number: 122 } },
      { label: 'Docs', status: 'tracked', context: 'Docs background.', waits_on: ['Build'] },
    ],
  })
  tick()
  upsertBoard(db, {
    ...alpha, stream: '123-old', title: 'Retired', repo: REPO, issueRef: 128,
    rows: [{ label: 'Old', status: 'partial', issue: { repo: REPO, number: 124 } }],
  })
  // more recorded outcomes than the archived summary carries for one project
  // (#299), each at its own time, so which it carries and what it omits
  // depend on the outcome stamps
  for (let i = 0; i < 5; i++) {
    tick()
    updateBoardRow(db, {
      ...alpha, stream: '123-old', title: 'Retired', repo: REPO, issueRef: 128,
      expectedBoardVersion: getBoard(db, 'alpha', 'Retired')!.revision, label: `Shipped ${i}`, status: 'done', outcome: `Outcome ${i}.`,
    })
  }
  const retired = getBoard(db, 'alpha', 'Retired')!
  archiveBoard(db, retired.id, retired.revision)

  tick()
  const preview = (n: number) => ({
    preview_url: `https://preview.example/${n}`, preview_environment: 'preview', preview_deployment_id: n,
    preview_updated_at: new Date(clock).toISOString(),
  })
  upsertSourceLink(db, { repo: REPO, branch: '120-work', pr_number: 41, pr_state: 'OPEN', pr_title: 'Ship', closing_refs: [{ repo: REPO, number: 120 }], ...preview(41) })
  upsertSourceLink(db, {
    repo: REPO, branch: '121-work', head_repo: 'fork/agent-inbox', pr_number: 52, pr_state: 'OPEN', issue_number: 121,
    closing_refs: [{ repo: REPO, number: 121 }], ...preview(52),
  })
  upsertSourceLink(db, { repo: REPO, branch: '117-umbrella', pr_number: 50, pr_state: 'OPEN', closing_refs: [{ repo: REPO, number: 117 }], ...preview(50) })
  upsertSourceLink(db, { repo: REPO, branch: '123-old', pr_number: 60, pr_state: 'MERGED', closing_refs: [{ repo: REPO, number: 123 }] })
  upsertSourceLink(db, { repo: REPO, branch: '130-beta', pr_number: 70, pr_state: 'OPEN', ...preview(70) })
  upsertSourceLink(db, { repo: REPO, branch: 'gone', pr_number: 9, pr_state: 'MERGED', ...preview(9) })
  recordLinkFailure(db, { repo: REPO, branch: '119-work', error: 'offline' })

  const startedAt = tick()
  upsertIssueSnapshot(db, { repo: REPO, number: 116, startedAt, snapshot: snapshot(key(116)) })
  upsertIssueSnapshot(db, { repo: REPO, number: 117, startedAt, snapshot: snapshot(key(117), { children: [key(120), key(122)] }) })
  upsertIssueSnapshot(db, { repo: REPO, number: 120, startedAt, snapshot: snapshot(key(120), { ancestors: [key(117)] }) })
  upsertIssueSnapshot(db, { repo: REPO, number: 122, startedAt, snapshot: snapshot(key(122), { ancestors: [key(117)], issue: { state: 'CLOSED' } }) })
  upsertIssueSnapshot(db, { repo: REPO, number: 123, startedAt, snapshot: snapshot(key(123)) })
  upsertIssueSnapshot(db, { repo: REPO, number: 124, startedAt, snapshot: snapshot(key(124)) })
  upsertIssueSnapshot(db, { repo: REPO, number: 130, startedAt, snapshot: snapshot(key(130)) })
  upsertIssueSnapshot(db, { repo: REPO, number: 131, startedAt, snapshot: snapshot(key(131)) })
  recordIssueFailure(db, { repo: REPO, number: 121, error: 'not-found', startedAt })

  // the tables no snapshot reads
  tick()
  upsertActivity(db, { ...alpha, session: 'mcp-1', stream: '', doing: 'Working' })
  recordActivityCall(db, 'mcp-1')
  claimHookWatch(db, 'host:1', 'token-1')
  claimIssueRefresh(db, { owner: 'viewer-1', queue: [{ repo: REPO, number: 125, checked_at: null }], limit: 1, leaseMs: 60_000, nowMs: clock })
  db.prepare(`INSERT INTO source_links (repo, branch, checked_at) VALUES (?, ?, ?)`).run(REPO, 'legacy', new Date(clock).toISOString())

  const release = getBoard(db, 'alpha', 'Release')!
  return { asked, answered, release: release.id, approve: release.rows.find((row) => row.label === 'Approve')!.id }
}

function tablesOf(db: Hub): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>)
    .map((table) => table.name)
}

function columnsOf(db: Hub, table: string): Array<{ name: string; type: string; pk: number }> {
  return db.prepare(`SELECT name, type, pk FROM pragma_table_info(?)`).all(table) as Array<{ name: string; type: string; pk: number }>
}

// The columns of the primary key and of each unique index: each must stay
// unique, so a copied row changes the last column of every one of them.
function uniqueKeys(db: Hub, table: string): string[][] {
  const pk = columnsOf(db, table).filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name)
  const indexes = db.prepare(`SELECT name FROM pragma_index_list(?) WHERE "unique" = 1`).all(table) as Array<{ name: string }>
  const keys = indexes.map(({ name }) => (db.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`).all(name) as Array<{ name: string }>)
    .map((column) => column.name))
  return pk.length ? [pk, ...keys] : keys
}

function token(db: Hub, name: Snapshot): string {
  const state = readSnapshotState(db)
  return JSON.stringify([state.schemaVersion, ...SNAPSHOT_SOURCES[name].map((domain: Domain) => state.domains[domain])])
}

function covers(name: Snapshot, table: string, column?: string): boolean {
  return SNAPSHOT_SOURCES[name].some((domain: Domain) => {
    const spec = DOMAINS[domain]
    return spec.table === table && (column === undefined || spec.columns === undefined || spec.columns.includes(column))
  })
}

describe('snapshot domains (issue #297)', () => {
  let dir: string
  let path: string
  let db: Hub
  let writer: Hub
  let app: ReturnType<typeof createViewer>
  let fixture: Fixture

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    clock = T0
    vi.setSystemTime(clock)
    dir = scratchDir('snapshot-domains-')
    path = join(dir, 'inbox.db')
    db = openDb(path)
    writer = openDb(path)
    app = createViewer(db)
    fixture = seed(writer)
    tick()
  })

  afterEach(() => {
    if (writer.open) writer.close()
    if (db.open) db.close()
    removeScratchDirs()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function body(name: Snapshot): Promise<string> {
    const response = await app.request(ROUTES[name])
    return `${response.status} ${await response.text()}`
  }

  const warm = () => warmOn(app)
  const probe = (name: Snapshot, etag: string) => probeOn(app, name, etag)
  // writes land a second after the warm-up, as they would in a running hub
  const rebuiltBy = (write: () => unknown) => rebuiltOn(app, () => {
    tick()
    return write()
  })

  describe('the mapping', () => {
    it('serves each snapshot from the route this file names, over domains the store declares', () => {
      expect(Object.keys(SNAPSHOT_SOURCES).sort()).toEqual([...SNAPSHOTS].sort())
      for (const name of SNAPSHOTS) {
        expect(SNAPSHOT_SOURCES[name].length, name).toBeGreaterThan(0)
        for (const domain of SNAPSHOT_SOURCES[name]) expect(Object.keys(SNAPSHOT_DOMAINS), name).toContain(domain)
      }
      // a domain no snapshot reads would only cost its triggers
      const used = new Set(SNAPSHOTS.flatMap((name) => [...SNAPSHOT_SOURCES[name]]))
      expect([...used].sort()).toEqual(Object.keys(SNAPSHOT_DOMAINS).sort())
    })

    it('classifies every table: read through a domain, or read by no snapshot, never both', () => {
      const fresh = openDb(join(dir, 'fresh.db'))
      try {
        const read = new Set(Object.values(DOMAINS).map((spec) => spec.table))
        for (const table of tablesOf(fresh)) {
          expect(read.has(table) !== (table in UNREAD), `${table}: give it a domain or a reason in UNREAD`).toBe(true)
        }
        for (const table of [...read, ...Object.keys(UNREAD)]) expect(tablesOf(fresh), table).toContain(table)
      } finally {
        fresh.close()
      }
    })

    it('makes a column added to a table read in part fail until someone reviews it', () => {
      const fresh = openDb(join(dir, 'fresh.db'))
      try {
        const partial = new Set(Object.values(DOMAINS).filter((spec) => spec.columns !== undefined).map((spec) => spec.table))
        expect([...partial].sort()).toEqual(Object.keys(REVIEWED_COLUMNS).sort())
        for (const table of partial) {
          expect(columnsOf(fresh, table).map((column) => column.name).sort(), `${table} gained or lost a column`)
            .toEqual(REVIEWED_COLUMNS[table])
        }
        for (const [domain, spec] of Object.entries(DOMAINS)) {
          for (const column of spec.columns ?? []) expect(REVIEWED_COLUMNS[spec.table], domain).toContain(column)
          // a misspelt stamp would only stay in the catch-all trigger, so name real ones
          const columns = columnsOf(fresh, spec.table).map((column) => column.name)
          for (const column of spec.restamped ?? []) expect(columns, domain).toContain(column)
          expect(spec.columns === undefined || spec.restamped === undefined, domain).toBe(true)
        }
      } finally {
        fresh.close()
      }
    })

    it('keeps a version for every domain and its triggers, named by their definition', () => {
      const fresh = openDb(join(dir, 'fresh.db'))
      try {
        // every version starts at its own random 48-bit value
        const versions = fresh.prepare(`SELECT domain, version FROM snapshot_domains ORDER BY domain`).all() as Array<{ domain: string; version: number }>
        expect(versions.map((row) => row.domain)).toEqual(Object.keys(SNAPSHOT_DOMAINS).sort())
        for (const { domain, version } of versions) {
          expect(Number.isSafeInteger(version) && version >= 0 && version < 2 ** 48, `${domain}: ${version}`).toBe(true)
        }
        expect(new Set(versions.map((row) => row.version)).size).toBe(versions.length)
        const triggers = (fresh.prepare(`SELECT name, tbl_name AS tableName FROM sqlite_master
            WHERE type = 'trigger' AND name LIKE 'snapshot\\_%' ESCAPE '\\' ORDER BY name`).all() as Array<{ name: string; tableName: string }>)
        // One insert, one delete and one update trigger per domain, and one more
        // for each delivery stamp a whole-table domain value-checks.
        const expected = Object.entries(DOMAINS).flatMap(([domain, spec]) =>
          ['insert', 'delete', 'update', ...(spec.restamped ?? []).map((column) => `update_${column}`)]
            .map((event) => ({ name: `snapshot_${domain}_${event}`, tableName: spec.table })))
        const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        expect(triggers.map(({ name, tableName }) => ({ name: name.replace(/_[0-9a-f]{12}$/, ''), tableName })).sort(byName))
          .toEqual(expected.sort(byName))
        // Together, a whole-table domain's update triggers watch every column of
        // its table in a hub opened once: a column made after them would go
        // unwatched until some process opened the hub again.
        for (const [domain, spec] of Object.entries(DOMAINS)) {
          if (spec.columns) continue
          const watched = (fresh.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'`).all() as Array<{ name: string; sql: string }>)
            .filter(({ name }) => name.startsWith(`snapshot_${domain}_update_`))
            // the quoted identifiers of each OF list, quotes undoubled
            .flatMap(({ sql }) => [...(/AFTER UPDATE OF ((?:"(?:[^"]|"")*"(?:, )?)+) ON /.exec(sql)![1]!).matchAll(/"((?:[^"]|"")*)"/g)]
              .map((match) => match[1]!.replaceAll('""', '"')))
          expect(watched.sort(), domain).toEqual(columnsOf(fresh, spec.table).map((column) => column.name).sort())
        }
        // A trigger's name ends in a hash of its text, and a hub keeps every
        // trigger it was ever given. So changing a definition, or only how its
        // text is laid out, adds new triggers beside the old ones in every
        // existing hub, which then fire on each write as well. Change these
        // names on purpose only, by regenerating test/fixtures/snapshot-triggers.txt.
        expect(triggers.map((trigger) => trigger.name)).toEqual(TRIGGERS)
        // Opening the hub again changes nothing: no schema change, no new trigger.
        const schema = readSnapshotState(fresh).schemaVersion
        const again = openDb(join(dir, 'fresh.db'))
        again.close()
        expect(readSnapshotState(fresh).schemaVersion).toBe(schema)
      } finally {
        fresh.close()
      }
    })
  })

  // The generic proof, over every table and column of the live schema: whatever
  // a write changes, a snapshot whose token did not move serves the same bytes.
  // Each write runs in a savepoint on the viewer's own connection, where nothing
  // is cached, so the bytes are read fresh, and is then rolled back.
  it('moves a snapshot whenever a write to any table or column could change its bytes, and never for one it does not read', async () => {
    const baseline = {} as Record<Snapshot, string>
    for (const name of SNAPSHOTS) baseline[name] = await body(name)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const checked = { tables: new Set<string>(), moved: 0, unchanged: 0 }

    async function check(label: string, table: string, column: string | undefined, sql: string) {
      const before = Object.fromEntries(SNAPSHOTS.map((name) => [name, token(db, name)])) as Record<Snapshot, string>
      db.exec('SAVEPOINT mutation')
      try {
        const changes = db.prepare(sql).run().changes
        expect(changes, `${label} changed no row`).toBeGreaterThan(0)
        checked.tables.add(table)
        for (const name of SNAPSHOTS) {
          const moved = token(db, name) !== before[name]
          if (covers(name, table, column)) expect(moved, `${label} must move ${name}`).toBe(true)
          if (table in UNREAD) expect(moved, `${label} moved ${name}, which never reads ${table}`).toBe(false)
          if (moved) {
            checked.moved++
          } else {
            checked.unchanged++
            expect(await body(name), `${label} changed ${name} without moving its token`).toBe(baseline[name])
          }
        }
      } finally {
        db.exec('ROLLBACK TO mutation; RELEASE mutation')
      }
    }

    for (const table of tablesOf(db)) {
      if (table === 'snapshot_domains' || table === 'sqlite_sequence') continue
      const columns = columnsOf(db, table)
      const keys = uniqueKeys(db, table)
      const unique = new Set(keys.flat())
      for (const column of columns) {
        const numeric = /INT/i.test(column.type)
        // reversed: distinct values in the opposite order to the rows', so a
        // column that sorts or filters a snapshot changes it too
        const reversed = numeric ? '-1000 - rowid' : `'~' || printf('%09d', 999999999 - rowid)`
        await check(`${table}.${column.name} (reversed)`, table, column.name, `UPDATE ${table} SET ${column.name} = ${reversed}`)
        if (!unique.has(column.name)) {
          await check(`${table}.${column.name} (constant)`, table, column.name, `UPDATE ${table} SET ${column.name} = ${numeric ? '-7' : `'~same'`}`)
        }
        // a change of case alone, which a NOCASE comparison would not see
        const recased = `${column.name} IS NOT upper(${column.name}) COLLATE BINARY`
        if (!numeric && (db.prepare(`SELECT count(*) FROM ${table} WHERE ${recased}`).pluck().get() as number) > 0) {
          await check(`${table}.${column.name} (case)`, table, column.name, `UPDATE ${table} SET ${column.name} = upper(${column.name}) WHERE ${recased}`)
        }
      }
      const changed = new Set(keys.map((columnsOfKey) => columnsOfKey.at(-1)!))
      const values = columns.map((column) => (!changed.has(column.name) ? column.name
        : /INT/i.test(column.type) ? `${column.name} + 1000003` : `${column.name} || '~copy'`))
      await check(`a row inserted into ${table}`, table, undefined, `INSERT INTO ${table} (${columns.map((column) => column.name).join(', ')})
        SELECT ${values.join(', ')} FROM ${table} WHERE rowid = (SELECT MIN(rowid) FROM ${table})`)
      await check(`every row deleted from ${table}`, table, undefined, `DELETE FROM ${table}`)
    }
    error.mockRestore()
    // every table but the two skipped above was written, and both outcomes happened
    expect([...checked.tables].sort()).toEqual(tablesOf(db).filter((table) => !['snapshot_domains', 'sqlite_sequence'].includes(table)))
    expect(checked.moved).toBeGreaterThan(0)
    expect(checked.unchanged).toBeGreaterThan(0)
  }, 60_000)

  // The converse, where it matters: a delivery stamp pending() re-applies
  // unchanged on every poll moves no version, and a column domain moves only
  // when one of its values changed (a plan restamped with the same branch).
  it('moves no version for a delivery re-applied unchanged, and no column domain for an unchanged value', () => {
    const dump = (table: string) => JSON.stringify(db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all())
    let unchanged = 0
    for (const [domain, spec] of Object.entries(DOMAINS) as Array<[Domain, (typeof DOMAINS)[Domain]]>) {
      for (const column of spec.columns ?? spec.restamped ?? []) {
        const before = { domains: readSnapshotState(db).domains, rows: dump(spec.table) }
        db.exec('SAVEPOINT noop')
        try {
          expect(db.prepare(`UPDATE ${spec.table} SET ${column} = ${column}`).run().changes, `${domain}.${column}`).toBeGreaterThan(0)
          // another trigger can turn it into a change (a response revision, a delivery reset)
          if (dump(spec.table) !== before.rows) continue
          unchanged++
          const after = readSnapshotState(db).domains
          if (spec.columns) expect(after[domain], `${domain}.${column}`).toBe(before.domains[domain])
          else expect(after, `${domain}.${column}`).toEqual(before.domains)
        } finally {
          db.exec('ROLLBACK TO noop; RELEASE noop')
        }
      }
    }
    expect(unchanged).toBeGreaterThan(40)
  })

  describe.each(['same', 'other'] as const)('writes on the %s connection rebuild exactly the snapshots they can change', (source) => {
    const on = (): Hub => (source === 'same' ? db : writer)

    it.each([
      ['a real MCP call', () => recordActivityCall(on(), 'mcp-1')],
      ['the liveness tick', () => touchActivity(on(), 'mcp-1')],
      ['a presence registration', () => upsertActivity(on(), {
        session: 'mcp-3', project: 'alpha', stream: '', agent: 'copilot', doing: 'open', idle: true, claim: false, host_pid: 1, server_pid: 2,
      })],
      ['a status claim', () => upsertActivity(on(), { session: 'mcp-1', project: 'alpha', stream: '', agent: 'claude-code', doing: 'Reviewing' })],
      ['a session ending', () => endActivity(on(), 'mcp-1')],
      ['a hook watch lease taken and released', () => {
        claimHookWatch(on(), 'host:2', 'token-2')
        releaseHookWatch(on(), 'host:2', 'token-2')
      }],
      ['an issue refresh lease', () => claimIssueRefresh(on(), {
        owner: 'viewer-2', queue: [{ repo: REPO, number: 126, checked_at: null }], limit: 1, leaseMs: 60_000, nowMs: clock,
      }).length === 1],
    ])('%s rebuilds nothing', async (_, write) => {
      expect(await rebuiltBy(write)).toEqual([])
    })

    it.each([
      ['a new question', () => insertItem(on(), {
        project: 'alpha', stream: '127-work', agent: 'copilot', kind: 'question', title: 'New ask', repo: REPO, issue_ref: 127,
      }), [...ITEMS, 'links', 'issues']],
      ['an inbox reply', (f: Fixture) => replyItem(on(), f.asked, 'Ship it').ok, [...ITEMS, 'issues']],
      ['an agent picking an answer up', (f: Fixture) => {
        const item = getItem(on(), f.answered)!
        return markReplySeen(on(), f.answered, item.replied_at, item.response_revision)
      }, ITEMS],
      ['the same answer handed over again on a later poll', (f: Fixture) => {
        const item = getItem(on(), f.answered)!
        return markReplySeen(on(), f.answered, item.replied_at, item.response_revision)
      }, [], (f: Fixture) => {
        const item = getItem(writer, f.answered)!
        return markReplySeen(writer, f.answered, item.replied_at, item.response_revision)
      }],
      ['a pin for later', (f: Fixture) => pinItem(on(), f.asked, true), ITEMS],
      ['a resolve', (f: Fixture) => resolveItem(on(), f.asked, 'Shipped.').ok, [...ITEMS, 'links', 'issues']],
      ['a new plan', () => upsertBoard(on(), {
        project: 'alpha', stream: '128-work', agent: 'copilot', title: 'New plan', rows: [{ label: 'Start', status: 'tracked' }],
      }), [...PLANS, 'items', 'links', 'issues']],
      ['a row note', () => {
        const plan = getBoard(on(), 'alpha', 'Release')!
        const docs = plan.rows.find((row) => row.label === 'Docs')!
        return updateBoardRow(on(), {
          project: 'alpha', stream: '117-umbrella', agent: 'claude-code', title: 'Release', label: 'Docs', note: 'Drafted.', repo: REPO, issueRef: 117,
          expectedBoardVersion: plan.revision, expectedRevision: docs.revision,
        })
      }, [...PLANS, 'issues']],
      ['an agent reading a plan', (f: Fixture) => markBoardRead(on(), f.release), PLANS],
      ['an answer handed to an agent', (f: Fixture) => {
        const row = getBoard(on(), 'alpha', 'Release')!.rows.find((candidate) => candidate.id === f.approve)!
        return markAnnotationDelivered(on(), f.approve, row.annotated_at, 'claude-code')
      }, PLANS, (f: Fixture) => annotateBoardRow(writer, f.approve, 'Approve')],
      // a blocked row's answer is handed over on every poll until its status flips (#37)
      ['a blocked row’s answer handed over again', (f: Fixture) => {
        const row = getBoard(on(), 'alpha', 'Release')!.rows.find((candidate) => candidate.id === f.approve)!
        return markAnnotationDelivered(on(), f.approve, row.annotated_at, 'claude-code')
      }, [], (f: Fixture) => {
        expect(annotateBoardRow(writer, f.approve, 'Approve')).toBe(true)
        const row = getBoard(writer, 'alpha', 'Release')!.rows.find((candidate) => candidate.id === f.approve)!
        return markAnnotationDelivered(writer, f.approve, row.annotated_at, 'claude-code')
      }],
      // its statements still set every row, which moves the plans, but no value a
      // column domain reads changed, so nothing that reads plans in part moves
      ['a plan re-sent unchanged', () => {
        const plan = getBoard(on(), 'alpha', 'Release')!
        return upsertBoard(on(), {
          project: 'alpha', stream: '117-umbrella', agent: 'claude-code', title: 'Release', repo: REPO, issueRef: 117, expectedVersion: plan.revision,
          rows: plan.rows.map((row) => ({ label: row.label, status: row.status, revision: row.revision, note: row.note })),
        })
      }, PLANS],
      // #306: a plan re-sent by another MCP session moves only its `session`,
      // which /api/boards carries, so the plans rebuild though no revision moved
      ['a plan re-sent by another session', () => {
        const plan = getBoard(on(), 'alpha', 'Release')!
        return upsertBoard(on(), {
          project: 'alpha', stream: '117-umbrella', agent: 'claude-code', title: 'Release', repo: REPO, issueRef: 117, expectedVersion: plan.revision,
          session: 'mcp-other', rows: plan.rows.map((row) => ({ label: row.label, status: row.status, revision: row.revision, note: row.note })),
        })
      }, PLANS],
      ['a row pinned for later', (f: Fixture) => {
        const plan = getBoard(on(), 'alpha', 'Release')!
        return pinBoardRow(on(), f.approve, true, plan.rows.find((row) => row.id === f.approve)!.revision, plan.revision)
      }, PLANS],
      ['an archived plan', (f: Fixture) => archiveBoard(on(), f.release, getBoard(on(), 'alpha', 'Release')!.revision), [...PLANS, 'links', 'issues']],
      ['a project closed', () => closeProject(on(), 'alpha'), ['items', 'links', 'issues']],
      ['a project reopened', () => reopenProject(on(), 'beta'), ['items', 'links', 'issues']],
      ['a PR fetch', () => upsertSourceLink(on(), {
        repo: REPO, branch: '117-umbrella', pr_number: 50, pr_state: 'MERGED', closing_refs: [{ repo: REPO, number: 117 }],
      }), ['links', 'issues']],
      ['a failed PR fetch', () => recordLinkFailure(on(), { repo: REPO, branch: '117-umbrella', error: 'offline' }), ['links']],
      ['a deployment preview', () => {
        const link = on().prepare(`SELECT revision FROM source_links_by_head WHERE branch = '120-work'`).get() as { revision: number }
        return setSourcePreview(on(), { repo: REPO, branch: '120-work', revision: link.revision }, {
          preview_url: 'https://preview.example/42', preview_environment: 'preview', preview_deployment_id: 8,
          preview_updated_at: new Date(clock).toISOString(), preview_error: null,
        })
      }, ['links']],
      ['an issue snapshot', () => upsertIssueSnapshot(on(), {
        repo: REPO, number: 120, startedAt: new Date(clock).toISOString(), snapshot: snapshot(key(120), { ancestors: [key(117)], issue: { title: 'Renamed' } }),
      }), ['issues']],
      ['an issue fetch failing', () => recordIssueFailure(on(), { repo: REPO, number: 124, error: 'offline', startedAt: new Date(clock).toISOString() }), ['issues']],
      ['a completed refresh', () => completeIssueRefresh(on(), {
        owner: 'viewer-1', results: [{ repo: REPO, number: 125, startedAt: new Date(clock).toISOString(), snapshot: snapshot(key(125)) }],
      }) === 1, ['issues']],
      ['a dismissal', (f: Fixture) => {
        dismissItem(on(), f.asked)
        return true
      }, [...ITEMS, 'links', 'issues']],
    ] as Array<[string, (f: Fixture) => unknown, Snapshot[], ((f: Fixture) => unknown)?]>)('%s', async (_, write, expected, prepare) => {
      if (prepare) expect(prepare(fixture)).not.toBe(false)
      expect(await rebuiltBy(() => write(fixture))).toEqual(SNAPSHOTS.filter((name) => expected.includes(name)))
    })
  })

  it('rebuilds nothing for presence, claims and liveness written by another Node process', async () => {
    const tags = await warm()
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      `import { openDb, upsertActivity, recordActivityCall, touchActivity, claimHookWatch, claimIssueRefresh } from './src/store.ts'
       const db = openDb(process.env.AGENT_INBOX_DB)
       try {
         upsertActivity(db, { session: 'child', project: 'alpha', stream: '', agent: 'child', doing: 'Child work' })
         recordActivityCall(db, 'child')
         touchActivity(db, 'child')
         claimHookWatch(db, 'host:child', 'child')
         claimIssueRefresh(db, { owner: 'child', queue: [{ repo: '${REPO}', number: 127, checked_at: null }], limit: 1, leaseMs: 60000, nowMs: Date.now() })
       } finally { db.close() }`,
    ], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, AGENT_INBOX_DB: path, TSX_DISABLE_CACHE: '1' },
    })
    expect(child.status, child.stderr).toBe(0)
    for (const name of SNAPSHOTS) {
      const read = await probe(name, tags[name])
      expect([read.status, read.rebuilt], name).toEqual([304, false])
    }
    // the same process's item still lands where it should
    const other = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      `import { openDb, insertItem } from './src/store.ts'
       const db = openDb(process.env.AGENT_INBOX_DB)
       try { insertItem(db, { project: 'alpha', stream: '', agent: 'child', kind: 'note', title: 'From the child' }) } finally { db.close() }`,
    ], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, AGENT_INBOX_DB: path, TSX_DISABLE_CACHE: '1' },
    })
    expect(other.status, other.stderr).toBe(0)
    const items = await probe('items', tags.items)
    expect(items.status).toBe(200)
    expect(items.text).toContain('From the child')
    expect((await probe('boards', tags.boards)).rebuilt).toBe(false)
  }, 60_000)

  describe('publishing only what a read proved', () => {
    it('publishes a body whose own domains held still while other domains moved during its read', async () => {
      const prepare = db.prepare.bind(db)
      let wrote = false
      db.prepare = ((sql: string) => {
        const statement = prepare(sql)
        if (!wrote && /FROM board_rows WHERE board_id = \? ORDER BY position/.test(sql)) {
          const all = statement.all.bind(statement)
          statement.all = ((...args: unknown[]) => {
            const rows = all(...args)
            if (!wrote) {
              wrote = true
              recordActivityCall(writer, 'mcp-1')
              insertItem(writer, { project: 'alpha', stream: '', agent: 'copilot', kind: 'note', title: 'During the read' })
            }
            return rows
          }) as typeof statement.all
        }
        return statement
      }) as typeof db.prepare
      let etag: string
      try {
        const first = await app.request(ROUTES.boards)
        etag = first.headers.get('etag')!
        await first.text()
      } finally {
        db.prepare = prepare
      }
      expect(wrote).toBe(true)
      expect(await probe('boards', etag)).toMatchObject({ status: 304, rebuilt: false })
    })

    it('never publishes a body when one of its column domains moved during its read', async () => {
      const prepare = db.prepare.bind(db)
      let wrote = false
      db.prepare = ((sql: string) => {
        const statement = prepare(sql)
        // closedProjects() is the last statement of listLinkTargets(), so a
        // write after it is in no part of the body this read builds
        if (!wrote && /SELECT p\.project FROM projects p/.test(sql)) {
          const all = statement.all.bind(statement)
          statement.all = ((...args: unknown[]) => {
            const rows = all(...args)
            if (!wrote) {
              wrote = true
              // the open item that keeps the cached preview leaves the open work
              expect(resolveItem(writer, fixture.asked).ok).toBe(true)
            }
            return rows
          }) as typeof statement.all
        }
        return statement
      }) as typeof db.prepare
      let old: { etag: string; text: string }
      try {
        const first = await app.request(ROUTES.links)
        old = { etag: first.headers.get('etag')!, text: await first.text() }
      } finally {
        db.prepare = prepare
      }
      expect(wrote).toBe(true)
      expect(old.text).toContain('https://preview.example/41')
      const next = await probe('links', old.etag)
      expect(next).toMatchObject({ status: 200, rebuilt: true })
      expect(next.text).not.toContain('https://preview.example/41')
      expect(await probe('links', next.etag!)).toMatchObject({ status: 304, rebuilt: false })
    })

    // A rollback takes a version back, so a later commit can bring it to the
    // value an uncommitted read saw: only refusing to publish such a read keeps
    // that commit from revalidating bytes it never wrote.
    it('never publishes a read made inside a transaction, even when a later commit returns the versions it saw', async () => {
      const tags = await warm()
      const rollback = new Error('rollback fixture')
      let transient: Promise<Response> | undefined
      let seen = '' as number | string
      expect(() => db.transaction(() => {
        annotateItem(db, fixture.asked, 'Uncommitted correction')
        seen = readSnapshotState(db).domains.items
        transient = Promise.resolve(app.request(ROUTES.items))
        throw rollback
      })()).toThrow(rollback)
      expect(await (await transient!).text()).toContain('Uncommitted correction')
      expect(typeof seen).toBe('number')
      expect(readSnapshotState(db).domains.items).toBeLessThan(seen as number)
      expect(annotateItem(writer, fixture.asked, 'Committed correction')).toBe(true)
      // the same write, so the same triggers: the version the transaction saw is back
      expect(readSnapshotState(db).domains.items).toBe(seen)
      const read = await probe('items', tags.items)
      expect(read).toMatchObject({ status: 200, rebuilt: true })
      expect(read.text).toContain('Committed correction')
      expect(read.text).not.toContain('Uncommitted correction')
    })

    it('rebuilds every snapshot after any schema change, from any connection', async () => {
      const tags = await warm()
      writer.exec('CREATE TABLE scratch_297 (value TEXT)')
      for (const name of SNAPSHOTS) {
        const read = await probe(name, tags[name])
        expect([read.status, read.rebuilt], name).toEqual([304, true])
      }
    })

    // Only a hand-edited hub lacks a version row. Its version proves nothing, so
    // the domain falls back to the token every snapshot used before #297.
    it('rebuilds after any commit, and only then, while a domain it reads has no version row', async () => {
      const tags = await warm()
      writer.exec(`DELETE FROM snapshot_domains WHERE domain = 'items'`)
      for (const name of SNAPSHOTS) {
        const read = await probe(name, tags[name])
        expect([read.status, read.rebuilt], name).toEqual([304, SNAPSHOT_SOURCES[name].includes('items' as never)])
      }
      // idle, a 304 from the cache; any commit, even to a table no snapshot reads, rebuilds it
      expect(await probe('items', tags.items)).toMatchObject({ status: 304, rebuilt: false })
      recordActivityCall(writer, 'mcp-1')
      expect(await probe('items', tags.items)).toMatchObject({ status: 304, rebuilt: true })
      expect(await probe('items', tags.items)).toMatchObject({ status: 304, rebuilt: false })
      insertItem(writer, { project: 'alpha', stream: '', agent: 'copilot', kind: 'note', title: 'Still seen' })
      expect((await probe('items', tags.items)).text).toContain('Still seen')
    })
  })

  // Review of #368. A version proves something only while the triggers that move
  // it exist. A domain missing one (dropped, or not yet made for a column a
  // later build added) falls back to the commit token every snapshot used
  // before #297, rebuilt after any commit and a 304 otherwise, until an openDb
  // that makes the same trigger text makes it again. A column a later build
  // names with an SQL keyword must not break that openDb, and a row seeded
  // again after a reset must not land on a version a viewer cached.
  describe('trusting only the triggers a hub has', () => {
    const version = (domain: Domain) =>
      writer.prepare(`SELECT version FROM snapshot_domains WHERE domain = ?`).pluck().get(domain) as number
    const catchAll = (domain: Domain) => (writer.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).pluck().all() as string[])
      .find((name) => new RegExp(`^snapshot_${domain}_update_[0-9a-f]{12}$`).test(name))!
    const moved = (before: Record<string, number | string>, after: Record<string, number | string>) =>
      Object.keys(after).filter((domain) => after[domain] !== before[domain]).sort()
    const retitle = (title: string) => writer.prepare(`UPDATE items SET title = ? WHERE id = ?`).run(title, fixture.asked)

    it('watches columns a later build names with SQL keywords, or with a quote, once the hub is reopened', async () => {
      const tags = await warm()
      writer.exec(`ALTER TABLE board_rows ADD COLUMN "order" INTEGER;
        ALTER TABLE items ADD COLUMN "values" TEXT;
        ALTER TABLE items ADD COLUMN "group" TEXT;
        ALTER TABLE items ADD COLUMN "say ""when""" TEXT`)
      expect(() => openDb(path).close()).not.toThrow()
      let before = readSnapshotState(db).domains
      writer.prepare(`UPDATE board_rows SET "order" = 7 WHERE id = ?`).run(fixture.approve)
      let after = readSnapshotState(db).domains
      expect(moved(before, after)).toEqual(['board_rows'])
      for (const column of ['"values"', '"group"', '"say ""when"""']) {
        before = after
        writer.prepare(`UPDATE items SET ${column} = 'set' WHERE id = ?`).run(fixture.asked)
        after = readSnapshotState(db).domains
        expect(moved(before, after), column).toEqual(['items'])
      }
      const items = await probe('items', tags.items)
      expect(items.status).toBe(200)
      const asked = (JSON.parse(items.text).needsYou as Array<{ items: Array<{ id: string }> }>)
        .flatMap((group) => group.items).find((item) => item.id === fixture.asked)
      expect(asked).toMatchObject({ values: 'set', group: 'set', 'say "when"': 'set' })
      // /api/boards names its row columns, so the plans are rebuilt to the same bytes
      expect(await probe('boards', tags.boards)).toMatchObject({ status: 304, rebuilt: true })
    })

    it('rebuilds a domain after any commit, and only then, while one of its triggers is missing, and trusts its version again once a reopen makes it', async () => {
      const tags = await warm()
      const dropped = catchAll('items')
      writer.exec(`DROP TRIGGER "${dropped}"`)
      // the schema moved, so every body is rebuilt once; idle, each is a 304 from the cache
      for (const name of SNAPSHOTS) expect((await probe(name, tags[name])).rebuilt, name).toBe(true)
      for (const name of SNAPSHOTS) expect(await probe(name, tags[name]), name).toMatchObject({ status: 304, rebuilt: false })
      // any commit, even to a table no snapshot reads, rebuilds what reads the items, and nothing else
      recordActivityCall(writer, 'mcp-1')
      for (const name of SNAPSHOTS) {
        expect((await probe(name, tags[name])).rebuilt, name).toBe(SNAPSHOT_SOURCES[name].includes('items' as never))
      }
      // the viewer's own commit too, which only total_changes() sees
      recordActivityCall(db, 'mcp-1')
      for (const name of SNAPSHOTS) {
        expect((await probe(name, tags[name])).rebuilt, name).toBe(SNAPSHOT_SOURCES[name].includes('items' as never))
      }
      // so an item write that moves no version without the trigger still shows at once
      const items = version('items')
      retitle('Retitled while untrusted')
      expect(version('items')).toBe(items)
      for (const name of ['items', 'attention-items'] as const) {
        const read = await probe(name, tags[name])
        expect([read.status, read.rebuilt], name).toEqual([200, true])
        expect(read.text, name).toContain('Retitled while untrusted')
        expect(await probe(name, read.etag!), name).toMatchObject({ status: 304, rebuilt: false })
      }
      // an openDb that makes the same trigger text again makes the version proof again
      openDb(path).close()
      expect(catchAll('items')).toBe(dropped)
      const current = (await probe('items', tags.items)).etag!
      expect(await probe('items', current)).toMatchObject({ status: 304, rebuilt: false })
      recordActivityCall(writer, 'mcp-1')
      expect(await probe('items', current)).toMatchObject({ status: 304, rebuilt: false })
      retitle('Retitled once trusted')
      expect(version('items')).toBeGreaterThan(items)
      const read = await probe('items', current)
      expect([read.status, read.rebuilt]).toEqual([200, true])
      expect(read.text).toContain('Retitled once trusted')
    })

    it('rebuilds a domain after any commit while a column a later build added has no trigger, and watches it once a reopen makes one', async () => {
      const tags = await warm()
      writer.exec(`ALTER TABLE items ADD COLUMN later_note TEXT`)
      const first = await probe('items', tags.items)
      expect(first.rebuilt).toBe(true)
      expect(await probe('items', first.etag!)).toMatchObject({ status: 304, rebuilt: false })
      const items = version('items')
      writer.prepare(`UPDATE items SET later_note = ? WHERE id = ?`).run('before the reopen', fixture.asked)
      expect(version('items')).toBe(items)
      const fresh = await probe('items', first.etag!)
      expect([fresh.status, fresh.rebuilt]).toEqual([200, true])
      expect(fresh.text).toContain('"later_note":"before the reopen"')
      openDb(path).close()
      expect(await probe('items', fresh.etag!)).toMatchObject({ status: 304, rebuilt: true })
      expect(await probe('items', fresh.etag!)).toMatchObject({ status: 304, rebuilt: false })
      writer.prepare(`UPDATE items SET later_note = ? WHERE id = ?`).run('after the reopen', fixture.asked)
      expect(version('items')).toBeGreaterThan(items)
      const watched = await probe('items', fresh.etag!)
      expect([watched.status, watched.rebuilt]).toEqual([200, true])
      expect(watched.text).toContain('"later_note":"after the reopen"')
    })

    // Trust is remembered per schema cookie, so never from inside a transaction:
    // a rollback takes the cookie back, and a later commit can return it to the
    // value the transaction saw.
    it('never remembers trust read inside a transaction a rollback can take back', () => {
      const rollback = new Error('rollback fixture')
      let seen = 0
      expect(() => db.transaction(() => {
        db.exec('CREATE TABLE scratch_trust (value TEXT)')
        const state = readSnapshotState(db)
        seen = state.schemaVersion
        expect(typeof state.domains.items).toBe('number')
        throw rollback
      })()).toThrow(rollback)
      writer.exec(`DROP TRIGGER "${catchAll('items')}"`)
      const state = readSnapshotState(db)
      expect(state.schemaVersion).toBe(seen)
      expect(state.domains.items).toMatch(/^commits:/)
    })

    it('trusts nothing it read across a schema change, and remembers none of it', () => {
      writer.exec('CREATE TABLE scratch_first (value TEXT)')
      const prepare = db.prepare.bind(db)
      let moved = false
      db.prepare = ((sql: string) => {
        const statement = prepare(sql)
        if (!moved && /SELECT name FROM sqlite_master WHERE type = 'trigger'/.test(sql)) {
          const all = statement.all.bind(statement)
          statement.all = ((...args: unknown[]) => {
            const rows = all(...args)
            moved = true
            writer.exec('CREATE TABLE scratch_between (value TEXT)')
            return rows
          }) as typeof statement.all
        }
        return statement
      }) as typeof db.prepare
      try {
        const state = readSnapshotState(db)
        expect(moved).toBe(true)
        expect(Object.values(state.domains).every((token) => typeof token === 'string')).toBe(true)
      } finally {
        db.prepare = prepare
      }
      expect(Object.values(readSnapshotState(db).domains).every((token) => typeof token === 'number')).toBe(true)
    })

    it('reads the trigger list only when the schema cookie moves', async () => {
      const tags = await warm()
      const queries: string[] = []
      const prepare = db.prepare.bind(db)
      db.prepare = ((sql: string) => { queries.push(sql); return prepare(sql) }) as typeof db.prepare
      try {
        for (const name of SNAPSHOTS) await probe(name, tags[name])
        expect(queries.filter((sql) => /sqlite_master|pragma_table_info/.test(sql))).toEqual([])
        // one SELECT per token: the schema cookie, every version and the commit fallback together
        expect(queries.length).toBe(SNAPSHOTS.length)
        for (const sql of queries) {
          expect(sql).toMatch(/pragma_schema_version[\s\S]*pragma_data_version[\s\S]*snapshot_domains/)
          expect(sql).toContain('total_changes()')
        }
        writer.exec('CREATE TABLE scratch_cookie (value TEXT)')
        for (const name of SNAPSHOTS) await probe(name, tags[name])
        expect(queries.filter((sql) => /FROM sqlite_master/.test(sql))).toHaveLength(1)
      } finally {
        db.prepare = prepare
      }
    })

    // A version starts at a random 48-bit value: were it seeded at a fixed start,
    // a row reset and seeded again could climb back to the version an idle
    // viewer cached and revalidate bytes that changed.
    it('seeds a version at a random start, so a row seeded again cannot revalidate what an idle viewer cached', async () => {
      const tags = await warm()
      const cached = version('items')
      writer.exec(`DELETE FROM snapshot_domains WHERE domain = 'items'`)
      openDb(path).close()
      const seeded = version('items')
      const climb = seeded < cached && cached - seeded <= 10_000 ? cached - seeded : 1
      for (let n = 1; n <= climb; n++) retitle(`Retitled ${n} of ${climb}`)
      const read = await probe('items', tags.items)
      expect(read.status).toBe(200)
      expect(read.text).toContain(`Retitled ${climb} of ${climb}`)
    })
  })
})
