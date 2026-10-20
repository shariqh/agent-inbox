// Issue #103, PR1a acceptance criterion 1: a hub created by v1.3.1 migrates
// additively, and a v1.3.1 process can keep reading and writing it at the same
// time as this build.
//
// The old process is a second raw connection that runs ONLY frozen v1.3.1
// text: the schema in fixtures/v1.3.1-schema.sql and the statements below,
// copied verbatim from src/store.ts at tag v1.3.1 (insertItemRow, annotateItem,
// ensureBoard, upsertBoard's row insert, upsertSourceLink, recordLinkFailure,
// listItems and listSourceLinks). Never edit them to follow a newer schema:
// they stand for the process that cannot change. Later slices add their own
// frozen cases here (PR1b: closing_refs; PR2: plan and row links).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  insertItem, listBoards, listIssueSnapshots, listItems, listSourceLinks, openDb, recordIssueFailure,
  upsertIssueSnapshot, upsertSourceLink,
} from '../src/store.js'
import { issueKeyFor } from '../public/issue-key.js'
import { createViewer } from '../src/viewer.js'
import { at, snapshot } from './issue-fixtures.js'

const V131_SCHEMA = readFileSync(new URL('./fixtures/v1.3.1-schema.sql', import.meta.url), 'utf8')

const V131 = {
  insertItem: `INSERT INTO items (
       id, project, stream, agent, session, kind, title, detail, next_step,
       action_owner, impact, next_after, context, options, repo, issue_ref, head_repo,
       status, created_at, updated_at)
     VALUES (
       @id, @project, @stream, @agent, @session, @kind, @title, @detail, @next_step,
       @action_owner, @impact, @next_after, @context, @options, @repo, @issue_ref, @head_repo,
       'open', @created_at, @updated_at)`,
  annotateItem: `UPDATE items SET annotation = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
  insertBoard: `INSERT INTO boards (id, project, stream, agent, title, repo, issue_ref, head_repo, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  insertRow: `
          INSERT INTO board_rows (
            id, board_id, label, status, note, next_step, action_owner, impact,
            next_after, options, context, outcome, outcome_at, created_at,
            updated_at, action_started_at, action_version, revision, history, position)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, '[]', ?)`,
  upsertSourceLink: `INSERT INTO source_links_by_head (repo, branch, head_repo, provider, pr_number, pr_url, pr_title, pr_state, pr_head_sha, pr_draft,
       review_decision, checks, issue_number, issue_url, issue_title, tldr, fetched_at, checked_at, error,
       preview_url, preview_environment, preview_deployment_id, preview_updated_at, preview_error)
     VALUES (@repo, @branch, @head_repo, @provider, @pr_number, @pr_url, @pr_title, @pr_state, @pr_head_sha, @pr_draft,
       @review_decision, @checks, @issue_number, @issue_url, @issue_title, @tldr, @now, @now, NULL,
       @preview_url, @preview_environment, @preview_deployment_id, @preview_updated_at, @preview_error)
     ON CONFLICT(repo, branch, head_repo) DO UPDATE SET
       provider = @provider, pr_number = @pr_number, pr_url = @pr_url, pr_title = @pr_title,
       pr_state = @pr_state, pr_head_sha = @pr_head_sha, pr_draft = @pr_draft, review_decision = @review_decision, checks = @checks,
       issue_number = @issue_number, issue_url = @issue_url, issue_title = @issue_title, tldr = @tldr,
       preview_url = @preview_url, preview_environment = @preview_environment,
       preview_deployment_id = @preview_deployment_id, preview_updated_at = @preview_updated_at,
       preview_error = @preview_error, revision = source_links_by_head.revision + 1,
       fetched_at = @now, checked_at = @now, error = NULL
     RETURNING revision`,
  recordLinkFailure: `INSERT INTO source_links_by_head (repo, branch, head_repo, checked_at, error) VALUES (@repo, @branch, @head_repo, @now, @error)
     ON CONFLICT(repo, branch, head_repo) DO UPDATE SET checked_at = @now, error = @error,
       preview_url = NULL, preview_environment = NULL, preview_deployment_id = NULL,
       preview_updated_at = NULL, preview_error = NULL, revision = source_links_by_head.revision + 1`,
  listItems: `SELECT * FROM items ORDER BY created_at DESC`,
  listSourceLinks: `SELECT * FROM source_links_by_head ORDER BY repo ASC, branch ASC, head_repo ASC`,
}

const REPO = 'shariqh/agent-inbox'

describe('a v1.3.1 process sharing a hub with this build (issue #103)', () => {
  let dir: string
  let path: string
  const open: Database.Database[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(at(60)))
    dir = mkdtempSync(join(tmpdir(), 'mixed-version-'))
    path = join(dir, 'inbox.db')
  })

  afterEach(() => {
    for (const connection of open.splice(0)) if (connection.open) connection.close()
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  // v1.3.1's openDb(): the same pragmas, then its migration in one IMMEDIATE transaction
  function oldProcess(): Database.Database {
    const db = new Database(path)
    open.push(db)
    db.pragma('busy_timeout = 5000')
    db.pragma('journal_mode = WAL')
    db.transaction(() => db.exec(V131_SCHEMA)).immediate()
    return db
  }

  function newProcess(): Database.Database {
    const db = openDb(path)
    open.push(db)
    return db
  }

  function oldItem(db: Database.Database, id: string, issue: number) {
    db.prepare(V131.insertItem).run({
      id, project: 'agent-inbox', stream: `${issue}-work`, agent: 'old', session: null, kind: 'question',
      title: `Old process asks about #${issue}`, detail: '', next_step: '', action_owner: null, impact: '', next_after: '',
      context: '', options: null, repo: REPO, issue_ref: issue, head_repo: null, created_at: at(1), updated_at: at(1),
    })
  }

  function oldLink(db: Database.Database, branch: string) {
    return db.prepare(V131.upsertSourceLink).get({
      repo: REPO, branch, head_repo: REPO, provider: 'github', pr_number: 41, pr_url: null, pr_title: 'Old PR',
      pr_state: 'OPEN', pr_head_sha: null, pr_draft: 0, review_decision: null, checks: null, issue_number: null,
      issue_url: null, issue_title: null, tldr: null, preview_url: null, preview_environment: null,
      preview_deployment_id: null, preview_updated_at: null, preview_error: null, now: new Date().toISOString(),
    }) as { revision: number }
  }

  it('migrates the old hub additively while the old process stays open, and both keep reading and writing', async () => {
    const old = oldProcess()
    oldItem(old, 'old-120', 120)
    const tables = () => (old.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>)
      .map((t) => t.name)
    expect(tables()).not.toContain('issue_snapshots')

    const hub = newProcess()
    expect(tables()).toContain('issue_snapshots')
    expect(listItems(hub).map((item) => item.id)).toEqual(['old-120'])

    // interleaved: new snapshot writes between old writes, on two live connections
    expect(upsertIssueSnapshot(hub, { repo: REPO, number: 120, snapshot: snapshot(`${REPO}#120`, { ancestors: [`${REPO}#117`] }), startedAt: at(10) })).toBe(true)
    oldItem(old, 'old-121', 121)
    old.prepare(V131.annotateItem).run('A human note through the old viewer', at(11), 'old-120')
    expect(recordIssueFailure(hub, { repo: REPO, number: 121, error: 'offline', startedAt: at(12) })).toBe(true)
    const boardId = 'old-board'
    old.prepare(V131.insertBoard).run(boardId, 'agent-inbox', '117-umbrella', 'old', 'AHP integration', REPO, 117, null, at(13), at(13))
    old.prepare(V131.insertRow).run('old-row', boardId, 'Adapter', 'tracked', '', '', null, '', '', null, '', '', null, at(13), at(13), at(13), 0)
    expect(oldLink(old, '120-work').revision).toBe(1)
    old.prepare(V131.recordLinkFailure).run({ repo: REPO, branch: '121-work', head_repo: REPO, error: 'offline', now: at(14) })
    insertItem(hub, { project: 'agent-inbox', stream: 'main', agent: 'new', kind: 'note', title: 'New process note' })
    expect(upsertIssueSnapshot(hub, { repo: REPO, number: 117, snapshot: snapshot(`${REPO}#117`, { children: [`${REPO}#120`] }), startedAt: at(15) })).toBe(true)
    expect(oldLink(old, '120-work').revision).toBe(2)

    // the old process reads everything, including what this build wrote
    expect((old.prepare(V131.listItems).all() as Array<{ id: string; annotation: string | null }>).map((i) => i.id))
      .toEqual(expect.arrayContaining(['old-120', 'old-121']))
    expect(old.prepare(V131.listItems).all()).toHaveLength(3)
    expect((old.prepare(V131.listSourceLinks).all() as Array<{ branch: string }>).map((l) => l.branch)).toEqual(['120-work', '121-work'])

    // this build reads the old writes, and the old writes never touched its snapshots
    expect(listItems(hub).find((item) => item.id === 'old-120')).toMatchObject({ annotation: 'A human note through the old viewer' })
    expect(listBoards(hub)[0]).toMatchObject({ id: boardId, repo: REPO, issue_ref: 117, rows: [expect.objectContaining({ label: 'Adapter' })] })
    expect(listSourceLinks(hub).map((link) => [link.branch, link.error])).toEqual([['120-work', null], ['121-work', 'offline']])
    expect(listIssueSnapshots(hub).map((r) => [r.number, r.revision, r.fetched_at, r.error])).toEqual([
      [117, 1, at(15), null], [120, 1, at(10), null], [121, 1, null, 'offline'],
    ])
    const graph = await (await createViewer(hub).request('/api/issues')).json()
    expect(graph.roots.map((root: { key: string }) => root.key)).toEqual([`${REPO}#117`, `${REPO}#120`, `${REPO}#121`])
    expect(graph.edges).toEqual([expect.objectContaining({ from: `${REPO}#117`, to: `${REPO}#120` })])

    // an old process that restarts replays its migration on the migrated hub
    old.close()
    const restarted = oldProcess()
    oldItem(restarted, 'old-122', 122)
    expect(listIssueSnapshots(hub)).toHaveLength(3)
    expect(listItems(hub).map((item) => item.id)).toContain('old-122')
  })

  // PR1b: closing_refs is bound to the fetched_at written beside it, so an old
  // process that rewrites the row (moving fetched_at, never touching the column
  // it does not know) unbinds it, and the PR identity stops being certain.
  it('a v1.3.1 upsertSourceLink unbinds closing_refs; its failure write leaves them bound', () => {
    const old = oldProcess()
    const hub = newProcess()
    oldItem(old, 'old-120', 120)
    const item = listItems(hub)[0]!
    const identity = () => issueKeyFor(item, listSourceLinks(hub)[0] ?? null)

    upsertSourceLink(hub, {
      repo: REPO, branch: '120-work', head_repo: REPO, pr_number: 41, pr_state: 'OPEN', issue_number: 117,
      closing_refs: [{ repo: REPO, number: 117 }],
    })
    expect(identity()).toEqual({ key: `${REPO}#117`, source: 'pr', certain: true })

    // a failure keeps fetched_at, so the record stays bound
    vi.setSystemTime(Date.parse(at(61)))
    old.prepare(V131.recordLinkFailure).run({ repo: REPO, branch: '120-work', head_repo: REPO, error: 'offline', now: at(61) })
    expect(identity()).toEqual({ key: `${REPO}#117`, source: 'pr', certain: true })

    // the old success write moves fetched_at: the column survives but is unbound
    vi.setSystemTime(Date.parse(at(62)))
    old.prepare(V131.upsertSourceLink).get({
      repo: REPO, branch: '120-work', head_repo: REPO, provider: 'github', pr_number: 41, pr_url: null, pr_title: 'Old PR',
      pr_state: 'OPEN', pr_head_sha: null, pr_draft: 0, review_decision: null, checks: null, issue_number: 117,
      issue_url: null, issue_title: null, tldr: null, preview_url: null, preview_environment: null,
      preview_deployment_id: null, preview_updated_at: null, preview_error: null, now: at(62),
    })
    const link = listSourceLinks(hub)[0]!
    expect(JSON.parse(link.closing_refs!)).toMatchObject({ fetched_at: at(60) })
    expect(link.fetched_at).toBe(at(62))
    // the chip still shows #117, as v1.3.1 does, but draws no relationships
    expect(identity()).toEqual({ key: `${REPO}#117`, source: 'pr', certain: false })

    // the next write from this build binds it again
    vi.setSystemTime(Date.parse(at(63)))
    upsertSourceLink(hub, {
      repo: REPO, branch: '120-work', head_repo: REPO, pr_number: 41, pr_state: 'OPEN', issue_number: 117,
      closing_refs: [{ repo: REPO, number: 117 }],
    })
    expect(identity()).toEqual({ key: `${REPO}#117`, source: 'pr', certain: true })
  })
})
