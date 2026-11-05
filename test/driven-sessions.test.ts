// Issue #412, step 2 (hub side): the reserved projects a driver files its
// approval alerts in, and the `driven` presence flag a driver's lease in
// hook_watch_claims turns on. Design:
// docs/superpowers/specs/2026-10-31-driven-sessions-design.md §4.2, §5.1 and §6.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  ackMessage, annotateBoardRow, claimDriverSlot, claimHookWatch, closeProject, closedProjects, driverStopRequested, endActivity,
  getBoard, getItem, holdDriverLeases, hubDataVersion, insertItem, isDrivenSession, listActivity, listAnsweredSessionAsks,
  listOpenMessagesWithText, listPending, listPendingMessages, listPendingRows, listSessionQuestions, listUnansweredBoardRows,
  markReplySeen, openDb, readdressMessages, releaseDriverLeases, releaseHookWatch, replyItem, requestDriverStop,
  sendSessionMessage, upsertActivity, upsertBoard,
} from '../src/store.js'
import type { DriverLease } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { isReservedProject } from '../public/reserved-projects.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

// a driver's lease token: `<launch id>:<driver pid>:<nonce>` (§5.1)
const TOKEN = '11111111-2222-4333-8444-555555555555:4242:n1'
const LAUNCH = '11111111-2222-4333-8444-555555555555'
const OTHER_LAUNCH = '99999999-2222-4333-8444-555555555555'
const lease = (over: Partial<DriverLease> = {}): DriverLease => ({ launchId: LAUNCH, pid: 4242, nonce: 'n1', ...over })
const messageId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

let db: Database.Database

beforeEach(() => {
  db = openDb(join(scratchDir('driven-'), 'inbox.db'))
})

afterEach(() => {
  db.close()
  vi.useRealTimers()
  removeScratchDirs()
})

function presence(session: string, over: { host_pid?: number; server_pid?: number; project?: string } = {}): void {
  upsertActivity(db, {
    session, project: over.project ?? 'agent-inbox', stream: 'main', agent: 'copilot', doing: 'open', idle: true, claim: false,
    receives_messages: true, host_pid: over.host_pid ?? 76681, server_pid: over.server_pid ?? 76734,
  })
}

// A driver's approval alert: a question in `@sessions` carrying the agent's own
// MCP session, so it classifies as waiting (§4.2).
function alert(session: string): string {
  return insertItem(db, {
    project: '@sessions', stream: 'agent-inbox · main', agent: 'copilot', session, kind: 'question',
    title: 'Allow copilot to run `git push origin ai/x`?', action_owner: 'task',
    next_step: 'Answer in the terminal running the driver.',
  })
}

describe('reserved projects (#412 §4.2)', () => {
  it('reserves exactly @sessions and @mesh, not every @ project', () => {
    expect(['@sessions', '@mesh', '@scratch', 'sessions', '@Sessions'].map(isReservedProject))
      .toEqual([true, true, false, false, false])
  })

  it('no project-scoped reader returns an @sessions ask, answered or not, while its real project still reads its own', () => {
    presence('mcp-1')
    const ask = alert('mcp-1')
    replyItem(db, ask, 'allow_once')
    const own = insertItem(db, { project: 'agent-inbox', stream: 'main', agent: 'copilot', session: 'mcp-1', kind: 'question', title: 'Ship it?' })
    upsertBoard(db, {
      project: '@sessions', stream: '', agent: 'copilot', title: 'Approvals',
      rows: [{ label: 'Push', status: 'blocked', action_owner: 'task', note: 'Waiting on the human.', next_step: 'Answer in the terminal.' }],
    })
    for (const project of ['@sessions', '@mesh']) {
      expect(listPending(db, project, { includeInformational: true })).toEqual([])
      expect(listPending(db, project, { itemId: ask })).toEqual([])
      expect(listPendingRows(db, project)).toEqual([])
      expect(listUnansweredBoardRows(db, project)).toEqual([])
    }
    // the hook's read of its linked servers' questions skips the alert too
    expect(listSessionQuestions(db, ['mcp-1']).map((q) => q.id)).toEqual([own])
    expect(listPending(db, 'agent-inbox').map((q) => q.id)).toEqual([own])
    // the human still sees it: the item is stored and open
    expect(getItem(db, ask)).toMatchObject({ project: '@sessions', status: 'open', session: 'mcp-1' })
  })

  it('refuses to close a reserved project, so approvals cannot be muted; the viewer route says so with a 200', async () => {
    expect(closeProject(db, '@sessions')).toBe(false)
    expect(closeProject(db, '@mesh')).toBe(false)
    expect(closeProject(db, 'agent-inbox')).toBe(true)
    expect(closedProjects(db)).toEqual(['agent-inbox'])
    const viewer = createViewer(db)
    const post = (project: string) => viewer.request('/api/projects/close', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }),
    })
    const refused = await post('@sessions')
    expect(refused.status).toBe(200)
    expect(await refused.json()).toEqual({ ok: false, reason: 'reserved_project' })
    expect(await (await post('@scratch')).json()).toEqual({ ok: true })
    expect(closedProjects(db).sort()).toEqual(['@scratch', 'agent-inbox'])
  })
})

describe('driven sessions (#412 §5.1, §6)', () => {
  it('serves `driven` and isDrivenSession only while a driver’s lease on the session is under 90 s old', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-31T12:00:00.000Z'))
    presence('mcp-1')
    presence('mcp-2')
    // a Claude hook's watch lease on the same host is not a driver's
    claimHookWatch(db, 'host:76681', 'm1:1-watch')
    claimHookWatch(db, 'driven:mcp-1', TOKEN)
    const driven = () => listActivity(db).filter((row) => row.driven).map((row) => row.session)
    expect(driven()).toEqual(['mcp-1'])
    expect([isDrivenSession(db, 'mcp-1'), isDrivenSession(db, 'mcp-2')]).toEqual([true, false])
    vi.setSystemTime(Date.parse('2026-10-31T12:01:29.000Z'))
    expect(driven()).toEqual(['mcp-1'])
    vi.setSystemTime(Date.parse('2026-10-31T12:01:31.000Z'))
    expect(driven()).toEqual([])
    expect(isDrivenSession(db, 'mcp-1')).toBe(false)
    // a refresh brings it back; a release ends it at once
    claimHookWatch(db, 'driven:mcp-1', TOKEN)
    expect(driven()).toEqual(['mcp-1'])
    releaseHookWatch(db, 'driven:mcp-1', TOKEN)
    expect(driven()).toEqual([])
    expect(listActivity(db).every((row) => !('driven' in row))).toBe(true)
  })
})

describe('driver leases (#412 §5.1, §7)', () => {
  it('caps concurrent drivers inside one claim and names the launches already running', () => {
    expect(claimDriverSlot(db, lease({ launchId: LAUNCH, pid: 1001 }), 2)).toEqual({ ok: true })
    expect(claimDriverSlot(db, lease({ launchId: OTHER_LAUNCH, pid: 1002 }), 2)).toEqual({ ok: true })
    const third = '33333333-2222-4333-8444-555555555555'
    expect(claimDriverSlot(db, lease({ launchId: third, pid: 1003 }), 2)).toEqual({
      ok: false, running: [{ launch: LAUNCH, pid: 1001 }, { launch: OTHER_LAUNCH, pid: 1002 }],
    })
    // a driver re-claiming its own slot is not counted against itself
    expect(claimDriverSlot(db, lease({ launchId: LAUNCH, pid: 1001 }), 2)).toEqual({ ok: true })
    // a released driver frees its slot
    releaseDriverLeases(db, lease({ launchId: OTHER_LAUNCH, pid: 1002 }))
    expect(claimDriverSlot(db, lease({ launchId: third, pid: 1003 }), 2)).toEqual({ ok: true })
  })

  it('counts only fresh leases: a driver silent for over 90 s no longer holds a slot', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-31T12:00:00.000Z'))
    claimDriverSlot(db, lease({ pid: 1001 }), 1)
    vi.setSystemTime(Date.parse('2026-10-31T12:01:29.000Z'))
    expect(claimDriverSlot(db, lease({ launchId: OTHER_LAUNCH, pid: 1002 }), 1)).toMatchObject({ ok: false })
    vi.setSystemTime(Date.parse('2026-10-31T12:01:31.000Z'))
    expect(claimDriverSlot(db, lease({ launchId: OTHER_LAUNCH, pid: 1002 }), 1)).toEqual({ ok: true })
  })

  it('refuses malformed lease identities rather than writing an unparseable token', () => {
    expect(() => claimDriverSlot(db, lease({ launchId: 'not-a-uuid' }), 2)).toThrow(/launch id/)
    expect(() => claimDriverSlot(db, lease({ pid: 0 }), 2)).toThrow(/pid/)
    expect(() => claimDriverSlot(db, lease({ nonce: 'a:b' }), 2)).toThrow(/nonce/)
    expect(() => requestDriverStop(db, 'nope')).toThrow(/launch id/)
  })

  it('holds exactly the named driven sessions, never takes another launch’s fresh one, and serves `driven` while fresh', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-31T12:00:00.000Z'))
    for (const s of ['mcp-1', 'mcp-2', 'mcp-3']) presence(s)
    const mine = lease()
    const theirs = lease({ launchId: OTHER_LAUNCH, pid: 5151, nonce: 'n2' })
    claimDriverSlot(db, mine, 2)
    claimDriverSlot(db, theirs, 2)
    expect(holdDriverLeases(db, theirs, ['mcp-3'])).toEqual({ driver: true, held: ['mcp-3'] })
    expect(holdDriverLeases(db, mine, ['mcp-1', 'mcp-2', 'mcp-3'])).toEqual({ driver: true, held: ['mcp-1', 'mcp-2'] })
    const driven = () => listActivity(db).filter((row) => row.driven).map((row) => row.session).sort()
    expect(driven()).toEqual(['mcp-1', 'mcp-2', 'mcp-3'])
    expect(isDrivenSession(db, 'mcp-1')).toBe(true)
    // a session no longer named is released; the other launch's lease is untouched
    expect(holdDriverLeases(db, mine, ['mcp-1'])).toEqual({ driver: true, held: ['mcp-1'] })
    expect(driven()).toEqual(['mcp-1', 'mcp-3'])
    // a lease 90 s old is no longer served, and then another launch may take it
    vi.setSystemTime(Date.parse('2026-10-31T12:01:31.000Z'))
    expect(driven()).toEqual([])
    expect(isDrivenSession(db, 'mcp-1')).toBe(false)
    expect(holdDriverLeases(db, theirs, ['mcp-1', 'mcp-3'])).toEqual({ driver: true, held: ['mcp-1', 'mcp-3'] })
  })

  it('reports a lost driver lease, and releases only its own leases and its launch’s Stop', () => {
    presence('mcp-1')
    presence('mcp-2')
    const first = lease({ nonce: 'first' })
    const second = lease({ launchId: OTHER_LAUNCH, nonce: 'second' }) // same pid, reused after a crash
    claimDriverSlot(db, first, 2)
    holdDriverLeases(db, first, ['mcp-1'])
    claimDriverSlot(db, second, 2)
    holdDriverLeases(db, second, ['mcp-2'])
    expect(holdDriverLeases(db, first, ['mcp-1']).driver).toBe(false)
    requestDriverStop(db, LAUNCH)
    requestDriverStop(db, OTHER_LAUNCH)
    expect(driverStopRequested(db, LAUNCH)).toBe(true)
    releaseDriverLeases(db, first)
    expect(driverStopRequested(db, LAUNCH)).toBe(false)
    expect(driverStopRequested(db, OTHER_LAUNCH)).toBe(true)
    expect(isDrivenSession(db, 'mcp-1')).toBe(false)
    expect(isDrivenSession(db, 'mcp-2')).toBe(true)
  })
})

describe('messages a driver pushes (#412 §5.2, §5.3)', () => {
  it('lists the open messages of the driven sessions with their text, oldest first', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-31T12:00:00.000Z'))
    presence('mcp-1')
    presence('mcp-2')
    sendSessionMessage(db, { id: messageId(2), session: 'mcp-1', text: 'Also run the DOM tests.' })
    vi.setSystemTime(Date.parse('2026-10-31T12:00:01.000Z'))
    sendSessionMessage(db, { id: messageId(1), session: 'mcp-2', text: '/allow-all' })
    sendSessionMessage(db, { id: messageId(3), session: 'mcp-1', text: 'Never mind.' })
    ackMessage(db, { id: messageId(3), session: 'mcp-1', outcome: 'Dropped.' })
    expect(listOpenMessagesWithText(db, ['mcp-1', 'mcp-2']).map((m) => [m.id, m.session, m.text])).toEqual([
      [messageId(2), 'mcp-1', 'Also run the DOM tests.'],
      [messageId(1), 'mcp-2', '/allow-all'],
    ])
    expect(listOpenMessagesWithText(db, [])).toEqual([])
  })

  function launchWithMessages(): void {
    presence('old', { host_pid: 76681, server_pid: 76734 })
    presence('new', { host_pid: 76681, server_pid: 76900 })
    presence('nested', { host_pid: 76817, server_pid: 76850 })
    sendSessionMessage(db, { id: messageId(1), session: 'old', text: 'Run the tests.' })
    sendSessionMessage(db, { id: messageId(2), session: 'old', text: 'Then push.' })
    sendSessionMessage(db, { id: messageId(3), session: 'old', text: 'Taken back.' })
    ackMessage(db, { id: messageId(3), session: 'old', outcome: 'Skipped.' })
    claimDriverSlot(db, lease(), 2)
    holdDriverLeases(db, lease(), ['old', 'new', 'nested'])
  }

  it('moves an ended session’s open messages to the launch’s own live server, and only then can that server ack them', () => {
    launchWithMessages()
    expect(readdressMessages(db, { from: 'old', to: 'new', launchId: LAUNCH, hostPid: 76681 }))
      .toEqual({ ok: false, reason: 'from_live' })
    endActivity(db, 'old')
    expect(readdressMessages(db, { from: 'old', to: 'new', launchId: LAUNCH, hostPid: 76681 }))
      .toEqual({ ok: true, moved: [messageId(1), messageId(2)] })
    expect(listPendingMessages(db, 'new').map((m) => m.text)).toEqual(['Run the tests.', 'Then push.'])
    expect(listPendingMessages(db, 'old')).toEqual([])
    expect(ackMessage(db, { id: messageId(1), session: 'old', outcome: 'Done.' })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(ackMessage(db, { id: messageId(1), session: 'new', outcome: 'Done.' })).toMatchObject({ ok: true })
  })

  it('accepts a dead server the driver reports even while its presence row still reads live', () => {
    launchWithMessages()
    expect(readdressMessages(db, { from: 'old', to: 'new', launchId: LAUNCH, hostPid: 76681, fromServerDead: true }))
      .toMatchObject({ ok: true, moved: [messageId(1), messageId(2)] })
  })

  it('never re-addresses to a nested CLI, another launch’s session or across launches', () => {
    launchWithMessages()
    endActivity(db, 'old')
    // the nested server is linked to nothing here, but even holding a lease of this launch its host is not the launch's
    expect(readdressMessages(db, { from: 'old', to: 'nested', launchId: LAUNCH, hostPid: 76681 }))
      .toEqual({ ok: false, reason: 'target_not_launch_host' })
    expect(readdressMessages(db, { from: 'old', to: 'new', launchId: OTHER_LAUNCH, hostPid: 76681 }))
      .toEqual({ ok: false, reason: 'not_one_launch' })
    presence('foreign', { host_pid: 76681, server_pid: 77000 })
    expect(readdressMessages(db, { from: 'old', to: 'foreign', launchId: LAUNCH, hostPid: 76681 }))
      .toEqual({ ok: false, reason: 'not_one_launch' })
    expect(readdressMessages(db, { from: 'old', to: 'old', launchId: LAUNCH, hostPid: 76681 }))
      .toEqual({ ok: false, reason: 'same_session' })
    endActivity(db, 'new')
    expect(readdressMessages(db, { from: 'old', to: 'new', launchId: LAUNCH, hostPid: 76681 }))
      .toEqual({ ok: false, reason: 'target_not_launch_host' })
    expect(listPendingMessages(db, 'old').map((m) => m.id)).toEqual([messageId(1), messageId(2)])
  })
})

describe('what a driver pings and polls (#412 §2, §5.3)', () => {
  it('lists answered, unread asks of the sessions’ own questions and plans, never a reserved project or another writer’s plan', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-31T12:00:00.000Z'))
    const own = insertItem(db, { project: 'agent-inbox', stream: 'main', agent: 'copilot', session: 'mcp-1', kind: 'question', title: 'Which pool?' })
    const read = insertItem(db, { project: 'agent-inbox', stream: 'main', agent: 'copilot', session: 'mcp-1', kind: 'question', title: 'Read already' })
    const alertId = insertItem(db, { project: '@sessions', stream: '', agent: 'copilot', session: 'mcp-1', kind: 'question', title: 'Allow?' })
    insertItem(db, { project: 'agent-inbox', stream: 'main', agent: 'copilot', session: 'mcp-1', kind: 'question', title: 'Unanswered' })
    for (const id of [own, read, alertId]) replyItem(db, id, 'yes')
    const picked = getItem(db, read)!
    markReplySeen(db, read, picked.replied_at, picked.response_revision, 'copilot')
    for (const [title, session] of [['Mine', 'mcp-1'], ['Theirs', 'mcp-2']] as const) {
      upsertBoard(db, {
        project: 'agent-inbox', stream: 'main', agent: 'copilot', title, session,
        rows: [{ label: `${title} step`, status: 'blocked', action_owner: 'task', note: 'Waiting.', next_step: 'Do it.' }],
      })
      const board = getBoard(db, 'agent-inbox', title)!
      annotateBoardRow(db, board.rows[0]!.id, 'done', 'answer', board.rows[0]!.revision, board.revision)
    }
    const mine = getBoard(db, 'agent-inbox', 'Mine')!.rows[0]!
    expect(listAnsweredSessionAsks(db, ['mcp-1'])).toEqual([
      { key: `item:${own}:${getItem(db, own)!.response_revision}`, title: 'Which pool?' },
      { key: `row:${mine.id}:${mine.revision}`, title: 'Mine step' },
    ])
    expect(listAnsweredSessionAsks(db, [])).toEqual([])
  })

  it('reads data_version, which moves when another connection commits', () => {
    const other = openDb(db.name)
    try {
      const before = hubDataVersion(db)
      insertItem(other, { project: 'p', stream: '', agent: 'a', kind: 'note', title: 't' })
      expect(hubDataVersion(db)).not.toBe(before)
    } finally {
      other.close()
    }
  })
})

