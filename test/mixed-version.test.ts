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
  getBoard, insertItem, listActivity, listBoards, listHostSessions, listIssueEntities, listIssueSnapshots, listItems, listSourceLinks, openDb, recordIssueFailure,
  replyItem, upsertActivity, upsertBoard, upsertIssueSnapshot, upsertSourceLink,
} from '../src/store.js'
import { runHook } from '../src/hook.js'
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
  // PR2: the board writes a v1.3.1 upsertBoard/updateBoardRow/board_advance runs
  ensureBoard: `UPDATE boards
                   SET stream = ?, agent = ?, repo = ?, issue_ref = ?, head_repo = ?,
                       updated_at = CASE
                         WHEN stream IS NOT ? OR agent IS NOT ? OR repo IS NOT ? OR issue_ref IS NOT ? OR head_repo IS NOT ?
                         THEN ? ELSE updated_at END
                 WHERE id = ?`,
  upsertRow: `
          UPDATE board_rows
             SET status = @status,
                 note = @note,
                 position = @position,
                 updated_at = CASE
                   WHEN status IS NOT @status OR note IS NOT @note
                   THEN @now ELSE updated_at END
           WHERE id = @id`,
  rowContext: `UPDATE board_rows SET context = ?, updated_at = ? WHERE id = ? AND context IS NOT ?`,
  rowStatus: `UPDATE board_rows SET status = ?, updated_at = ? WHERE id = ? AND status IS NOT ?`,
  rowOutcome: `UPDATE board_rows
                 SET outcome_at = CASE
                       WHEN @text = '' THEN NULL
                       ELSE @now END,
                     updated_at = @now,
                     outcome = @text
               WHERE id = @id AND outcome IS NOT @text`,
  beginNewRowAction: `
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
     WHERE id = ?`,
  advanceRow: `
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
       WHERE id = ?`,
  incrementRowRevision: `UPDATE board_rows SET revision = revision + 1 WHERE id = ? RETURNING revision`,
  bumpBoardRevision: `UPDATE boards SET revision = revision + 1, updated_at = ? WHERE id = ? RETURNING revision`,
  syncBoardStatus: `UPDATE boards SET status = ?, updated_at = ? WHERE id = ?`,
  listItems: `SELECT * FROM items ORDER BY created_at DESC`,
  listSourceLinks: `SELECT * FROM source_links_by_head ORDER BY repo ASC, branch ASC, head_repo ASC`,
  // #253: a v1.3.1 MCP server's presence write (registration and status)
  upsertActivity: `INSERT INTO activity (session, project, stream, agent, doing, last_doing, detail, children, idle, started_at, updated_at, server_version, server_source)
     VALUES (
       @session, @project, @stream, @agent, @doing,
       CASE WHEN @claim = 1 AND @idle = 0 AND @doing <> '' AND @doing <> 'open' THEN @doing ELSE '' END,
       @detail, @children, @idle, @now, @now, @server_version, @server_source
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
       updated_at = @now, ended_at = NULL`,
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

  // PR2 acceptance criterion 6: no statement a v1.3.1 process runs names the
  // link columns, so none of its board and row writes can clear them.
  it('v1.3.1 board and row writes on a migrated hub never clear plan pins or row links', () => {
    const old = oldProcess()
    const hub = newProcess()
    upsertBoard(hub, {
      project: 'agent-inbox', stream: '119-adapter', agent: 'new', title: 'AHP', repo: REPO, issueRef: 119,
      issuePin: { repo: REPO, number: 117 },
      rows: [{ label: 'Input', status: 'tracked', issue: { repo: REPO, number: 120 } }, { label: 'Other', status: 'done', issue: { repo: 'o/r', number: 5 } }],
    })
    const board = getBoard(hub, 'agent-inbox', 'AHP')!
    const [input, other] = board.rows
    const links = () => {
      const b = getBoard(hub, 'agent-inbox', 'AHP') ?? listBoards(hub, { status: 'archived' })[0]!
      const byLabel = [...b.rows].sort((x, y) => x.label.localeCompare(y.label))
      return [b.issue_pin_repo, b.issue_pin_number, ...byLabel.flatMap((r) => [r.issue_repo, r.issue_number])]
    }
    const expected = [REPO, 117, REPO, 120, 'o/r', 5]
    expect(links()).toEqual(expected)

    // a v1.3.1 upsertBoard: restamp the board, rewrite each row, bump revisions
    vi.setSystemTime(Date.parse(at(61)))
    const now = at(61)
    old.prepare(V131.ensureBoard).run('121-other', 'old', REPO, 121, null, '121-other', 'old', REPO, 121, null, now, board.id)
    old.prepare(V131.upsertRow).run({ status: 'partial', note: 'Old agent note', position: 1, now, id: input!.id })
    old.prepare(V131.upsertRow).run({ status: 'done', note: '', position: 0, now, id: other!.id })
    old.prepare(V131.rowContext).run('Old context', now, input!.id, 'Old context')
    old.prepare(V131.rowOutcome).run({ text: 'Shipped by the old agent', now, id: other!.id })
    old.prepare(V131.incrementRowRevision).get(input!.id)
    old.prepare(V131.bumpBoardRevision).get(now, board.id)
    expect(links()).toEqual(expected)

    // a v1.3.1 updateBoardRow that reblocks the row, then its board_advance
    old.prepare(V131.beginNewRowAction).run(now, 2, '[]', now, input!.id)
    old.prepare(V131.rowStatus).run('blocked', now, input!.id, 'blocked')
    old.prepare(V131.beginNewRowAction).run(now, 3, '[]', now, input!.id)
    old.prepare(V131.advanceRow).run('Next', 'Do it.', 'task', 'Moves on.', '', null, null, null, now, input!.id)
    old.prepare(V131.bumpBoardRevision).get(now, board.id)
    expect(links()).toEqual(expected)

    // its completeness sync archives and reactivates the plan
    old.prepare(V131.syncBoardStatus).run('archived', now, board.id)
    expect(links()).toEqual(expected)
    old.prepare(V131.syncBoardStatus).run('active', now, board.id)
    expect(links()).toEqual(expected)

    // and this build still reads every link as the entity's certain identity source
    const entities = listIssueEntities(hub)
    expect(entities.find((e) => e.id === board.id)).toMatchObject({ issue_pin_repo: REPO, issue_pin_number: 117 })
    expect(entities.filter((e) => e.kind === 'row').map((e) => [e.issue_repo, e.issue_number]).sort())
      .toEqual([['o/r', 5], [REPO, 120]])
  })

  // #253: the hook links to a server only through the host it recorded. An old
  // server records none, so a hook sharing the hub with it keeps today's watch
  // of the cwd project, and the old server's migration replays cleanly.
  it('a v1.3.1 server’s presence row links no hook to it, while this build’s row does', async () => {
    const old = oldProcess()
    const hub = newProcess()
    const presence = (session: string) => ({
      session, project: 'homelab', stream: '', agent: 'claude-code', doing: 'open', detail: '', children: null,
      idle: 1, claim: 0, server_version: '1.3.1', server_source: 'checkout', now: new Date().toISOString(),
    })
    old.prepare(V131.upsertActivity).run(presence('old-mcp'))
    const asked = insertItem(hub, { project: 'homelab', stream: '', agent: 'claude-code', session: 'old-mcp', kind: 'question', title: 'Which pool?' })
    replyItem(hub, asked, 'tank')
    const stop = () => runHook(['stop'], JSON.stringify({ session_id: 'S1', cwd: process.cwd() }), { AGENT_INBOX_DB: path })
    expect(listHostSessions(hub, process.ppid)).toEqual([])
    expect(await stop()).toEqual({ stdout: '' })

    // the old server keeps writing beside this build, and replays its migration
    old.prepare(V131.upsertActivity).run({ ...presence('old-mcp'), project: 'footage' })
    old.close()
    const restarted = oldProcess()
    restarted.prepare(V131.upsertActivity).run(presence('old-mcp-2'))
    expect(listActivity(hub).map((a) => [a.session, a.project]).sort()).toEqual([['old-mcp', 'footage'], ['old-mcp-2', 'homelab']])
    expect(listHostSessions(hub, process.ppid)).toEqual([])

    // the same row from this build carries its host, and the hook follows it
    upsertActivity(hub, { session: 'new-mcp', project: 'homelab', stream: '', agent: 'claude-code', doing: 'open', idle: true, claim: false, host_pid: process.ppid, server_pid: process.pid })
    expect(listHostSessions(hub, process.ppid)).toEqual([{ session: 'new-mcp', project: 'homelab', server_pid: process.pid }])
    expect(JSON.parse((await stop()).stdout)).toMatchObject({ decision: 'block', reason: expect.stringContaining('project homelab') })
  })
})
