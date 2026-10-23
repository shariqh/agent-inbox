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
// frozen cases here (PR1b: closing_refs; PR2: plan and row links). The
// statements of a v1.4.0 process (#247's pins, slice 2's issue snapshots and
// waits_on, and the replies and chat answers #322's report must see) are in
// their own blocks at the end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  getBoard, getItem, insertItem, listActivity, listBoards, listHostSessions, listIssueEntities, listIssueSnapshots, listItems, listSourceLinks,
  markReplySeen, openDb, pinBoardRow, pinItem, recordIssueFailure, replyItem, stopBoardRowWatch, stopItemWatch, updateBoardRow, upsertActivity,
  upsertBoard, upsertIssueSnapshot, upsertSourceLink,
} from '../src/store.js'
import type { IssueDependencies } from '../src/store.js'
import { issueQueue } from '../src/issue-poller.js'
import { buildIssueGraph } from '../src/issue-graph.js'
import { runHook } from '../src/hook.js'
import { issueKeyFor } from '../public/issue-key.js'
import { createViewer } from '../src/viewer.js'
import { at, facts, keySets, snapshot } from './issue-fixtures.js'
import { scratchDir } from './scratch.js'

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
    dir = scratchDir('mixed-version-')
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

// Issue #247 — the writes a v1.4.0 process runs, copied verbatim from src/store.ts
// at tag v1.4.0. None names pinned_at, so a re-send of the same ask keeps a pin,
// and only the two triggers can end one when that process answers, closes or
// moves the ask on. v1.4.0's migration only adds what is missing, so on a hub
// this build migrated it changes nothing: these statements are what matter.
const V140 = {
  upsertRow: `
          UPDATE board_rows
             SET status = @status,
                 note = @note,
                 position = @position,
                 updated_at = CASE
                   WHEN status IS NOT @status OR note IS NOT @note
                   THEN @now ELSE updated_at END
           WHERE id = @id`,
  // updateRowTextField for `impact`
  rowText: `UPDATE board_rows SET impact = ?, updated_at = ? WHERE id = ? AND impact IS NOT ?`,
  incrementRowRevision: `UPDATE board_rows SET revision = revision + 1 WHERE id = ? RETURNING revision`,
  bumpBoardRevision: `UPDATE boards SET revision = revision + 1, updated_at = ? WHERE id = ? RETURNING revision`,
  rowStatus: `UPDATE board_rows SET status = ?, updated_at = ? WHERE id = ? AND status IS NOT ?`,
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
           action_agent = ?,
           action_agent_version = ?,
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
  annotateBoardRow: `UPDATE board_rows
                               SET annotation = ?, annotation_kind = ?, annotated_at = ?,
                                   annotation_seen_at = NULL, annotation_seen_by = NULL,
                                   snoozed_until = NULL, updated_at = ?, revision = revision + 1
                             WHERE id = ? AND (? IS NULL OR revision = ?)
                               AND EXISTS (
                                 SELECT 1 FROM boards b
                                  WHERE b.id = board_rows.board_id
                                    AND b.status = 'active'
                                    AND (? IS NULL OR b.revision = ?))
                             RETURNING board_id`,
  markRowHandled: `UPDATE board_rows
                 SET handled_at = ?, handled_seen_at = NULL, handled_seen_by = NULL,
                     snoozed_until = NULL, updated_at = ?, revision = revision + 1
               WHERE id = ? AND (? IS NULL OR revision = ?)
                 AND EXISTS (
                   SELECT 1 FROM boards b
                    WHERE b.id = board_rows.board_id
                      AND b.status = 'active'
                      AND (? IS NULL OR b.revision = ?))
               RETURNING board_id`,
  snoozeBoardRow: `UPDATE board_rows
                               SET snoozed_until = ?, updated_at = ?, revision = revision + 1
                             WHERE id = ? AND status = 'blocked'
                               AND (? IS NULL OR revision = ?)
                               AND COALESCE(annotation, '') = '' AND annotation_kind IS NULL
                               AND handled_at IS NULL
                               AND EXISTS (
                                 SELECT 1 FROM boards b
                                  WHERE b.id = board_rows.board_id
                                    AND b.status = 'active'
                                    AND (? IS NULL OR b.revision = ?))
                             RETURNING board_id`,
  replyItem: `UPDATE items
                   SET reply = @reply, reply_context = @replyContext, replied_at = @now, reply_seen_at = NULL,
                       reply_source = 'inbox', reply_kind = @kind,
                       snoozed_until = NULL, updated_at = @now
                 WHERE id = @id AND kind = 'question' AND status = 'open'`,
  answerItem: `UPDATE items
          SET reply = ?, reply_context = ?, replied_at = ?, reply_seen_at = ?,
              reply_source = 'agent', reply_kind = ?, snoozed_until = NULL, updated_at = ?
       WHERE id = ? AND kind = 'question' AND status = 'open'
         AND (reply IS NULL OR reply = '' OR reply_seen_at IS NOT NULL)
       RETURNING response_revision + 1 AS response_revision`,
  resolveItem: `UPDATE items
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
                      OR (@expected IS NULL AND response_revision = 0))`,
  dismissItem: `UPDATE items SET status = 'dismissed', updated_at = ? WHERE id = ?`,
  snoozeItem: `UPDATE items SET snoozed_until = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
  // issue #103 slice 2: upsertIssueSnapshot and recordIssueFailure (ISSUE_HARD_ERRORS_SQL expanded)
  upsertIssueSnapshot: `INSERT INTO issue_snapshots (repo, number, snapshot, fetched_at, checked_at, error)
     VALUES (@repo, @number, @snapshot, @startedAt, @startedAt, NULL)
     ON CONFLICT(repo, number) DO UPDATE SET
       snapshot = excluded.snapshot, fetched_at = excluded.fetched_at, checked_at = excluded.checked_at,
       error = NULL, revision = issue_snapshots.revision + 1
     WHERE excluded.checked_at > issue_snapshots.checked_at`,
  recordIssueFailure: `INSERT INTO issue_snapshots (repo, number, checked_at, error) VALUES (@repo, @number, @startedAt, @error)
     ON CONFLICT(repo, number) DO UPDATE SET
       checked_at = excluded.checked_at,
       error = CASE WHEN @hard = 0 AND issue_snapshots.error IN ('not-found', 'forbidden', 'moved')
                    THEN issue_snapshots.error ELSE excluded.error END,
       snapshot = CASE WHEN @hard = 1 THEN NULL ELSE issue_snapshots.snapshot END,
       fetched_at = CASE WHEN @hard = 1 THEN NULL ELSE issue_snapshots.fetched_at END,
       revision = issue_snapshots.revision + 1
     WHERE excluded.checked_at > issue_snapshots.checked_at`,
}

describe('a v1.4.0 process sharing a hub with pinned asks (#247)', () => {
  let dir: string
  let path: string
  const open: Database.Database[] = []
  const LABELS = ['Upload', 'Sign', 'Notes', 'Answer', 'Handled', 'Snoozed', 'Cleared']

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(at(60)))
    dir = scratchDir('mixed-version-pins-')
    path = join(dir, 'inbox.db')
  })

  afterEach(() => {
    for (const connection of open.splice(0)) if (connection.open) connection.close()
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  // v1.4.0's openDb() pragmas, on a hub this build already migrated
  function olderProcess(): Database.Database {
    const db = new Database(path)
    open.push(db)
    db.pragma('busy_timeout = 5000')
    db.pragma('journal_mode = WAL')
    return db
  }

  function pinnedPlan(hub: Database.Database) {
    upsertBoard(hub, {
      project: 'agent-inbox', stream: '', agent: 'new', title: 'Release',
      rows: LABELS.map((label) => ({ label, status: 'blocked' as const, note: `${label} it.`, next_step: 'Do it.', action_owner: 'task' as const, impact: 'Ships it.' })),
    })
    for (const label of LABELS) {
      const board = getBoard(hub, 'agent-inbox', 'Release')!
      const row = board.rows.find((candidate) => candidate.label === label)!
      expect(pinBoardRow(hub, row.id, true, row.revision, board.revision), label).toBe(true)
    }
    const board = getBoard(hub, 'agent-inbox', 'Release')!
    return { board, row: (label: string) => board.rows.find((candidate) => candidate.label === label)! }
  }

  const pins = (hub: Database.Database) => Object.fromEntries(
    getBoard(hub, 'agent-inbox', 'Release')!.rows.map((row) => [row.label, row.pinned_at]),
  )

  it('its re-send of the same ask keeps a row pin; its board_advance and move out of blocked clear one', () => {
    const hub = openDb(path)
    open.push(hub)
    const old = olderProcess()
    const { board, row } = pinnedPlan(hub)
    const now = at(61)

    // a v1.4.0 upsertBoard re-sending every row, still blocked, one with a new note and impact
    LABELS.forEach((label, position) => {
      old.prepare(V140.upsertRow).run({ status: 'blocked', note: label === 'Upload' ? 'Upload the signed build.' : row(label).note, position, now, id: row(label).id })
    })
    old.prepare(V140.rowText).run('Ships 1.5.', now, row('Upload').id, 'Ships 1.5.')
    old.prepare(V140.incrementRowRevision).get(row('Upload').id)
    old.prepare(V140.bumpBoardRevision).get(now, board.id)
    expect(pins(hub)).toEqual(Object.fromEntries(LABELS.map((label) => [label, at(60)])))

    // its board_advance: a new action, then the next ask
    old.prepare(V140.beginNewRowAction).run(now, 2, 'old', 2, '[]', now, row('Sign').id)
    old.prepare(V140.advanceRow).run('The notarized build is ready.', 'Sign it.', 'task', 'Ships it.', '', null, null, null, now, row('Sign').id)
    // its updateBoardRow moving an ask out of blocked, the first half of a re-block
    old.prepare(V140.rowStatus).run('partial', now, row('Notes').id, 'partial')
    old.prepare(V140.bumpBoardRevision).get(now, board.id)
    expect(pins(hub)).toMatchObject({ Upload: at(60), Sign: null, Notes: null })
    expect(getBoard(hub, 'agent-inbox', 'Release')!.rows.find((candidate) => candidate.label === 'Upload'))
      .toMatchObject({ note: 'Upload the signed build.', impact: 'Ships 1.5.', action_version: 1 })
  })

  it('its viewer’s answer or handled mark clears a row pin; its snooze and a cleared note leave the pin', () => {
    const hub = openDb(path)
    open.push(hub)
    const old = olderProcess()
    const { row } = pinnedPlan(hub)
    const now = at(61)
    old.prepare(V140.annotateBoardRow).get('Uploaded', 'answer', now, now, row('Answer').id, null, null, null, null)
    old.prepare(V140.markRowHandled).get(now, now, row('Handled').id, null, null, null, null)
    old.prepare(V140.snoozeBoardRow).get(at(120), now, row('Snoozed').id, null, null, null, null)
    old.prepare(V140.annotateBoardRow).get('', null, now, now, row('Cleared').id, null, null, null, null)
    expect(pins(hub)).toMatchObject({ Answer: null, Handled: null, Snoozed: at(60), Cleared: at(60), Upload: at(60) })
    // both set is harmless: the ask is set aside either way, and the snooze ends on its own
    expect(getBoard(hub, 'agent-inbox', 'Release')!.rows.find((candidate) => candidate.label === 'Snoozed')!.snoozed_until).toBe(at(120))
  })

  it('its reply, chat answer, resolve or dismiss clears a question pin; its snooze leaves the pin', () => {
    const hub = openDb(path)
    open.push(hub)
    const old = olderProcess()
    const ask = (title: string) => {
      const id = insertItem(hub, { project: 'agent-inbox', stream: '', agent: 'new', kind: 'question', title })
      expect(pinItem(hub, id, true), title).toBe(true)
      return id
    }
    const [replied, told, resolved, dismissed, snoozed] = ['Reply', 'Chat', 'Resolve', 'Dismiss', 'Snooze'].map(ask) as [string, string, string, string, string]
    const now = at(61)
    old.prepare(V140.replyItem).run({ id: replied, reply: 'Ship it', replyContext: null, kind: 'answer', now })
    old.prepare(V140.answerItem).get('Said in chat: ship it', null, now, now, 'answer', now, told)
    old.prepare(V140.resolveItem).run({ now, text: '', id: resolved, guarded: 0, expected: null })
    old.prepare(V140.dismissItem).run(now, dismissed)
    old.prepare(V140.snoozeItem).run(at(120), now, snoozed)
    for (const id of [replied, told, resolved, dismissed]) expect(getItem(hub, id)!.pinned_at, id).toBeNull()
    expect(getItem(hub, snoozed)).toMatchObject({ pinned_at: at(60), snoozed_until: at(120) })
  })

  // §5.4: this build's "I'll take a while" with Later on writes the watch stop
  // and a pin or snooze together. A v1.4.0 process knows neither the coupling
  // nor pins, so only its statements and the triggers can touch the result:
  // its re-send must keep both halves, and its new action must end both.
  it('after this build’s coupled "I’ll take a while", its re-send keeps both halves and its board_advance ends both', () => {
    const hub = openDb(path)
    open.push(hub)
    const old = olderProcess()
    const labels = ['Stopped', 'Quiet']
    upsertBoard(hub, {
      project: 'agent-inbox', stream: '', agent: 'new', title: 'Coupled',
      rows: labels.map((label) => ({ label, status: 'blocked' as const, note: `${label} it.`, next_step: 'Do it.', action_owner: 'task' as const, impact: 'Ships it.' })),
    })
    const board = () => getBoard(hub, 'agent-inbox', 'Coupled')!
    const row = (label: string) => board().rows.find((candidate) => candidate.label === label)!
    expect(stopBoardRowWatch(hub, row('Stopped').id, null, row('Stopped').revision, board().revision, { defer: true })).toBe(true)
    expect(stopBoardRowWatch(hub, row('Quiet').id, at(120), row('Quiet').revision, board().revision, { defer: true })).toBe(true)
    const question = insertItem(hub, { project: 'agent-inbox', stream: '', agent: 'new', kind: 'question', title: 'Coupled question' })
    expect(stopItemWatch(hub, question, null, { defer: true })).toBe(true)
    const now = at(61)

    labels.forEach((label, position) => {
      old.prepare(V140.upsertRow).run({ status: 'blocked', note: row(label).note, position, now, id: row(label).id })
    })
    expect(row('Stopped')).toMatchObject({ watch_stopped_at: at(60), watch_stopped_until: null, pinned_at: at(60), snoozed_until: null })
    expect(row('Quiet')).toMatchObject({ watch_stopped_at: at(60), watch_stopped_until: at(120), pinned_at: null, snoozed_until: at(120) })

    for (const [index, label] of labels.entries()) {
      old.prepare(V140.beginNewRowAction).run(now, 2, 'old', 2, '[]', now, row(label).id)
      old.prepare(V140.advanceRow).run(`Next ${index}.`, 'Do it.', 'task', 'Ships it.', '', null, null, null, now, row(label).id)
      expect(row(label), label).toMatchObject({
        action_version: 2, watch_stopped_at: null, watch_stopped_until: null, pinned_at: null, snoozed_until: null,
      })
    }
    old.prepare(V140.replyItem).run({ id: question, reply: 'Ship it', replyContext: null, kind: 'answer', now })
    expect(getItem(hub, question)!.pinned_at).toBeNull()
  })
})

// Issue #103 slice 2 §5.3: the dependency section is bound to the fetched_at
// written beside it. A v1.4.0 viewer knows nothing of the column, so its
// writes can only move or clear fetched_at, which unbinds the section rather
// than erasing it: mixed versions lose freshness, never correctness.
describe('a v1.4.0 viewer sharing a hub with this build (issue #103 slice 2)', () => {
  let dir: string
  let path: string
  const open: Database.Database[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(at(60)))
    dir = scratchDir('mixed-v140-')
    path = join(dir, 'inbox.db')
  })

  afterEach(() => {
    for (const connection of open.splice(0)) if (connection.open) connection.close()
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  // the hub is migrated by this build first; v1.4.0's own migration would only
  // replay CREATE TABLE IF NOT EXISTS and its known columns, never drop one
  function bothProcesses(): { hub: Database.Database; old: Database.Database } {
    const hub = openDb(path)
    const old = new Database(path)
    open.push(hub, old)
    old.pragma('busy_timeout = 5000')
    old.pragma('journal_mode = WAL')
    return { hub, old }
  }

  const KEY = { repo: REPO, number: 121 }
  const DEPS: IssueDependencies = {
    status: 'ok',
    blocked_by: { open: 2, total: 2, truncated: false, list: [facts(`${REPO}#119`), facts(`${REPO}#120`)] },
    blocking: { open: 0, total: 0, truncated: false, list: [] },
  }
  const oldSuccess = (old: Database.Database, startedAt: string) =>
    old.prepare(V140.upsertIssueSnapshot).run({ ...KEY, snapshot: JSON.stringify(snapshot(`${REPO}#121`)), startedAt })
  const oldFailure = (old: Database.Database, error: string, startedAt: string) =>
    old.prepare(V140.recordIssueFailure).run({ ...KEY, error, startedAt, hard: ['not-found', 'forbidden', 'moved'].includes(error) ? 1 : 0 })

  it('a v1.4.0 success unbinds the section, so this build reads "unknown" and fetches it again at once; its soft failure keeps it bound', () => {
    const { hub, old } = bothProcesses()
    const read = () => listIssueSnapshots(hub)[0]!
    const stored = () => (hub.prepare(`SELECT dependencies FROM issue_snapshots`).get() as { dependencies: string | null }).dependencies
    insertItem(hub, { project: 'agent-inbox', stream: '121-work', agent: 'new', kind: 'question', title: 'q', repo: REPO, issue_ref: 121 })
    const queue = () => issueQueue({
      entities: listIssueEntities(hub), links: listSourceLinks(hub), snapshots: listIssueSnapshots(hub), nowMs: Date.parse(at(13)),
    }).map((e) => [e.number, e.reason])

    upsertIssueSnapshot(hub, { ...KEY, snapshot: snapshot(`${REPO}#121`), dependencies: DEPS, startedAt: at(10) })
    expect(read().dependencies).toEqual(DEPS)

    // an old soft failure keeps fetched_at: the section stays bound and ages with the snapshot
    oldFailure(old, 'offline', at(11))
    expect(read()).toMatchObject({ fetched_at: at(10), error: 'offline', dependencies: DEPS })

    // an old success moves fetched_at without touching the column it does not know
    oldSuccess(old, at(12))
    expect(read()).toMatchObject({ fetched_at: at(12), error: null, snapshot: snapshot(`${REPO}#121`), dependencies: null })
    expect(JSON.parse(stored()!)).toMatchObject({ fetched_at: at(10), status: 'ok' })
    expect(queue()).toEqual([[121, 'upgrade']])

    // the next write from this build binds it again
    upsertIssueSnapshot(hub, { ...KEY, snapshot: snapshot(`${REPO}#121`), dependencies: DEPS, startedAt: at(13) })
    expect(read()).toMatchObject({ fetched_at: at(13), dependencies: DEPS })
    expect(queue()).toEqual([])
  })

  it('a v1.4.0 hard failure unbinds the section, and no later v1.4.0 write can bind the leftover again', () => {
    const { hub, old } = bothProcesses()
    const read = () => listIssueSnapshots(hub)[0]!
    upsertIssueSnapshot(hub, { ...KEY, snapshot: snapshot(`${REPO}#121`), dependencies: DEPS, startedAt: at(10) })

    oldFailure(old, 'not-found', at(11))
    expect(read()).toMatchObject({ snapshot: null, fetched_at: null, failure: 'hard', dependencies: null })
    // every later write that applies starts after checked_at, never at the leftover's fetched_at
    oldFailure(old, 'offline', at(12))
    oldSuccess(old, at(13))
    expect(read()).toMatchObject({ fetched_at: at(13), error: null, dependencies: null })
    expect(oldSuccess(old, at(10)).changes).toBe(0)
    expect(read()).toMatchObject({ fetched_at: at(13), dependencies: null })
  })

  // PR B (§6.1's fifth worked example, end to end): the graph never trusts an
  // unbound section, but the other end's own bound list still speaks, as of its fetch.
  it('a section a v1.4.0 success unbound draws no edge; #119’s own bound list still does, as of its fetch', () => {
    const { hub, old } = bothProcesses()
    const display = keySets([`${REPO}#121`, `${REPO}#119`])
    const graph = () => buildIssueGraph(listIssueSnapshots(hub), display)
    const blocks = () => graph().edges.filter((e) => e.kind === 'blocks').map((e) => [e.from, e.to, e.observed_at])
    upsertIssueSnapshot(hub, { ...KEY, snapshot: snapshot(`${REPO}#121`), dependencies: DEPS, startedAt: at(10) })
    expect(blocks()).toEqual([[`${REPO}#119`, `${REPO}#121`, at(10)], [`${REPO}#120`, `${REPO}#121`, at(10)]])

    oldSuccess(old, at(12))
    expect(blocks()).toEqual([])
    expect(graph().roots).toEqual([expect.objectContaining({ key: `${REPO}#121`, dependencies: 'unknown' })])

    upsertIssueSnapshot(hub, {
      repo: REPO, number: 119, snapshot: snapshot(`${REPO}#119`), startedAt: at(11), dependencies: {
        status: 'ok',
        blocked_by: { open: 0, total: 0, truncated: false, list: [] },
        blocking: { open: 1, total: 1, truncated: false, list: [facts(`${REPO}#121`)] },
      },
    })
    expect(blocks()).toEqual([[`${REPO}#119`, `${REPO}#121`, at(11)]])
  })
})

// Issue #103 slice 2, PR C (§11) — the rest of the plan writes a v1.4.0 process
// runs, copied verbatim from src/store.ts at tag v1.4.0 (V140 above holds the
// others). None names waits_on, so none can change it: a v1.4.0 upsert keeps it
// on every row that survives, and its DELETE leaves a dangling label behind.
const V140_PLAN = {
  ensureBoard: `UPDATE boards
                   SET stream = ?, agent = ?, repo = ?, issue_ref = ?, head_repo = ?,
                       updated_at = CASE
                         WHEN stream IS NOT ? OR agent IS NOT ? OR repo IS NOT ? OR issue_ref IS NOT ? OR head_repo IS NOT ?
                         THEN ? ELSE updated_at END
                 WHERE id = ?`,
  // updateRowTextField for `context`
  rowContext: `UPDATE board_rows SET context = ?, updated_at = ? WHERE id = ? AND context IS NOT ?`,
  rowActionOwner: `UPDATE board_rows SET action_owner = ?, updated_at = ? WHERE id = ? AND action_owner IS NOT ?`,
  rowOptions: `UPDATE board_rows SET options = ?, updated_at = ? WHERE id = ? AND options IS NOT ?`,
  rowIssueLink: `UPDATE board_rows SET issue_repo = ?, issue_number = ?, updated_at = ?
                            WHERE id = ? AND (issue_repo IS NOT ? OR issue_number IS NOT ?)`,
  rowOutcome: `UPDATE board_rows
                 SET outcome_at = CASE
                       WHEN @text = '' THEN NULL
                       ELSE @now END,
                     updated_at = @now,
                     outcome = @text
               WHERE id = @id AND outcome IS NOT @text`,
  insertRow: `
          INSERT INTO board_rows (
            id, board_id, label, status, note, next_step, action_owner, impact,
            next_after, options, context, outcome, outcome_at, created_at,
            updated_at, action_started_at, action_version, action_agent, action_agent_version,
            revision, history, position, issue_repo, issue_number)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 1, '[]', ?, ?, ?)`,
  deleteRow: `DELETE FROM board_rows WHERE id = ?`,
  syncBoardStatus: `UPDATE boards SET status = ?, updated_at = ? WHERE id = ?`,
}

describe('a v1.4.0 process sharing a hub with waits_on (#103 slice 2)', () => {
  let dir: string
  let path: string
  const open: Database.Database[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(at(60)))
    dir = scratchDir('mixed-version-waits-')
    path = join(dir, 'inbox.db')
  })

  afterEach(() => {
    for (const connection of open.splice(0)) if (connection.open) connection.close()
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  // v1.4.0's openDb() pragmas, on a hub this build already migrated
  function olderProcess(): Database.Database {
    const db = new Database(path)
    open.push(db)
    db.pragma('busy_timeout = 5000')
    db.pragma('journal_mode = WAL')
    return db
  }

  function releasePlan() {
    const hub = openDb(path)
    open.push(hub)
    upsertBoard(hub, {
      project: 'agent-inbox', stream: '', agent: 'new', title: 'Release',
      rows: [
        { label: 'Build', status: 'tracked' },
        { label: 'Sign', status: 'tracked', waits_on: ['Build'] },
        { label: 'Publish', status: 'tracked', waits_on: ['Sign', 'Build'] },
      ],
    })
    const board = getBoard(hub, 'agent-inbox', 'Release')!
    const id = (label: string) => board.rows.find((candidate) => candidate.label === label)!.id
    const current = () => getBoard(hub, 'agent-inbox', 'Release') ?? listBoards(hub, { status: 'archived' })[0]!
    const waits = () => Object.fromEntries(current().rows.map((row) => [row.label, row.waits_on]))
    return { hub, board, id, current, waits }
  }

  it('none of its board, row or viewer writes changes waits_on', () => {
    const { board, id, waits } = releasePlan()
    const old = olderProcess()
    const expected = { Build: null, Sign: ['Build'], Publish: ['Build', 'Sign'] }
    expect(waits()).toEqual(expected)

    // a v1.4.0 upsertBoard: restamp the plan, then rewrite every field of every row
    vi.setSystemTime(Date.parse(at(61)))
    const now = at(61)
    old.prepare(V140_PLAN.ensureBoard).run('121-other', 'old', REPO, 121, null, '121-other', 'old', REPO, 121, null, now, board.id)
    ;['Build', 'Sign', 'Publish'].forEach((label, i) => {
      old.prepare(V140.upsertRow).run({ status: 'partial', note: `Old note ${i}`, position: 2 - i, now, id: id(label) })
      old.prepare(V140.rowText).run('Old impact', now, id(label), 'Old impact')
      old.prepare(V140_PLAN.rowContext).run('Old context', now, id(label), 'Old context')
      old.prepare(V140_PLAN.rowActionOwner).run('task', now, id(label), 'task')
      old.prepare(V140_PLAN.rowOptions).run(null, now, id(label), null)
      old.prepare(V140_PLAN.rowIssueLink).run(REPO, 120 + i, now, id(label), REPO, 120 + i)
      old.prepare(V140_PLAN.rowOutcome).run({ text: 'Old outcome', now, id: id(label) })
      old.prepare(V140.incrementRowRevision).get(id(label))
    })
    old.prepare(V140.bumpBoardRevision).get(now, board.id)
    expect(waits()).toEqual(expected)

    // its updateBoardRow re-blocks Publish, its viewer snoozes, answers and marks it handled, its board_advance moves on
    const publish = id('Publish')
    old.prepare(V140.beginNewRowAction).run(now, 2, 'old', 2, '[]', now, publish)
    old.prepare(V140.rowStatus).run('blocked', now, publish, 'blocked')
    old.prepare(V140.snoozeBoardRow).get(at(120), now, publish, null, null, null, null)
    old.prepare(V140.annotateBoardRow).get('Ship it.', 'answer', now, now, publish, null, null, null, null)
    old.prepare(V140.markRowHandled).get(now, now, publish, null, null, null, null)
    old.prepare(V140.beginNewRowAction).run(now, 3, 'old', 3, '[]', now, publish)
    old.prepare(V140.advanceRow).run('Announce it.', 'Approve the post.', 'task', 'Tells users.', '', null, null, null, now, publish)
    old.prepare(V140.bumpBoardRevision).get(now, board.id)
    expect(waits()).toEqual(expected)

    // its completeness sync archives and reactivates the plan
    old.prepare(V140_PLAN.syncBoardStatus).run('archived', now, board.id)
    expect(waits()).toEqual(expected)
    old.prepare(V140_PLAN.syncBoardStatus).run('active', now, board.id)
    expect(waits()).toEqual(expected)
  })

  it('its DELETE leaves a label this build keeps; its re-insert brings the row back with nothing to wait on', () => {
    const { hub, board, id, current, waits } = releasePlan()
    const old = olderProcess()
    const now = at(61)

    // a v1.4.0 upsert that omits Build deletes it
    old.prepare(V140_PLAN.deleteRow).run(id('Build'))
    old.prepare(V140.bumpBoardRevision).get(now, board.id)
    expect(waits()).toEqual({ Sign: ['Build'], Publish: ['Build', 'Sign'] })

    // this build keeps the dangling label through a routine write and a re-send of it
    const row = (label: string) => current().rows.find((candidate) => candidate.label === label)!
    updateBoardRow(hub, {
      project: 'agent-inbox', stream: '', agent: 'new', title: 'Release', label: 'Sign',
      expectedBoardVersion: current().revision, expectedRevision: row('Sign').revision, status: 'partial',
    })
    upsertBoard(hub, {
      project: 'agent-inbox', stream: '', agent: 'new', title: 'Release', expectedVersion: current().revision,
      rows: [
        { label: 'Sign', status: 'partial', revision: row('Sign').revision, waits_on: ['Build'] },
        { label: 'Publish', status: 'tracked', revision: row('Publish').revision, waits_on: ['Build', 'Sign'] },
      ],
    })
    expect(waits()).toEqual({ Sign: ['Build'], Publish: ['Build', 'Sign'] })

    // a v1.4.0 upsert adds Build back: its insert writes no waits_on, so the
    // revived labels can only point at it, and no cycle can form through it
    old.prepare(V140_PLAN.insertRow).run(
      'old-build', board.id, 'Build', 'tracked', '', '', null, '', '', null, '', '', null, now, now, now, 'old', 2, null, null,
    )
    expect(waits()).toEqual({ Sign: ['Build'], Publish: ['Build', 'Sign'], Build: null })
    // so a cycle through it is still this build's to refuse
    expect(() => updateBoardRow(hub, {
      project: 'agent-inbox', stream: '', agent: 'new', title: 'Release', label: 'Build',
      expectedBoardVersion: current().revision, expectedRevision: row('Build').revision, waits_on: ['Publish'],
    })).toThrow('waits_on would create a cycle: Build → Publish → Build')
  })
})

// Issue #322: this build's reply says what it did and the answer it left. That
// answer comes from the columns every version writes, never from anything only
// this build records, so the reply or chat answer an older process writes after
// this build's send landed is exactly what a replay of that send reports.
describe('a v1.4.0 process answering after this build’s send landed (#322)', () => {
  let dir: string
  let path: string
  const open: Database.Database[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(at(60)))
    dir = scratchDir('mixed-version-replies-')
    path = join(dir, 'inbox.db')
  })

  afterEach(() => {
    for (const connection of open.splice(0)) if (connection.open) connection.close()
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  // v1.4.0's openDb() pragmas, on a hub this build already migrated
  function olderProcess(): Database.Database {
    const db = new Database(path)
    open.push(db)
    db.pragma('busy_timeout = 5000')
    db.pragma('journal_mode = WAL')
    return db
  }

  it('a replay of the landed send writes nothing and reports the older process’s reply or chat answer', () => {
    const hub = openDb(path)
    open.push(hub)
    const old = olderProcess()
    const intent = { clientId: 'window-w', sequence: 1, actionId: 'w-1' }
    const [replied, told] = ['Reply', 'Chat'].map((title) => {
      const id = insertItem(hub, { project: 'agent-inbox', stream: '', agent: 'new', kind: 'question', title })
      expect(replyItem(hub, id, 'Original X', undefined, 'answer', intent)).toMatchObject({ ok: true, wrote: true })
      return id
    }) as [string, string]

    vi.setSystemTime(Date.parse(at(61)))
    const now = at(61)
    // its viewer answers again, and its MCP server records a chat answer once the agent read Original X
    old.prepare(V140.replyItem).run({ id: replied, reply: 'Later Y', replyContext: 'from the older viewer', kind: 'answer', now })
    expect(markReplySeen(hub, told, getItem(hub, told)!.replied_at)).toBe(true)
    old.prepare(V140.answerItem).get('Thursday, said in chat', null, now, now, 'answer', now, told)

    const expected = {
      [replied]: { replied_at: now, reply_source: 'inbox', reply_kind: 'answer', reply: 'Later Y', reply_context: 'from the older viewer' },
      [told]: { replied_at: now, reply_source: 'agent', reply_kind: 'answer', reply: 'Thursday, said in chat', reply_context: null },
    }
    vi.setSystemTime(Date.parse(at(62)))
    for (const id of [replied, told]) {
      const before = getItem(hub, id)
      expect(replyItem(hub, id, 'Original X', undefined, 'answer', intent), id)
        .toEqual({ ok: true, wrote: false, replayed: true, answer: expected[id] })
      expect(getItem(hub, id), id).toEqual(before)
    }
  })
})
