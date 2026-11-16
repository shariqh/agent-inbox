// Issue #612 (PR 2): requests, the work a person hands a session. The store's
// rules: opening (a prompt's unfiled request and an agent's declared one), the
// id prefix, filing, updating, closing with the items it writes in the same
// transaction, the settlement of a review by its hand-off, the caps, retention,
// adoption by a new session and the orphan close. Design:
// docs/superpowers/specs/2026-11-15-requests-design.md (§3.2, §3.6, §3.8).
// Fixtures are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  acknowledgeHandoff, adoptChatRequests, closeRequest, dismissItem, dropOrphanRequest, endActivity, fileRequest, getItem,
  insertItem, listHostSessions, listItems, listOpenAsks, listRequests, listSessionRequests, listUnfiledRequests,
  markAcksDelivered, openAgentRequest, openDb, openPromptRequest, pruneRequests, resolveItem, resolveRequestId,
  updateRequest, upsertActivity,
} from '../src/store.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const T0 = Date.parse('2026-11-15T12:00:00.000Z')
const MIN = 60_000
const DAY = 24 * 60 * MIN
const iso = (ms: number) => new Date(ms).toISOString()

let db: Database.Database
let clock = T0

function at(ms: number): void {
  clock = ms
  vi.setSystemTime(clock)
}

/** a live session of this project, with a server process that runs (this one) */
function present(session: string, over: { project?: string; stream?: string; agent?: string; server_pid?: number } = {}): void {
  upsertActivity(db, {
    session, project: over.project ?? 'alpha', stream: over.stream ?? 'main', agent: over.agent ?? 'claude-code',
    doing: 'open', idle: true, claim: false, host_pid: 4242, server_pid: over.server_pid ?? process.pid,
  })
}

/** a pid no process holds now: a child that has already exited */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid!
}

const CHAT_A = 'claude:11111111-aaaa-4bbb-8ccc-000000000001'
const CHAT_B = 'claude:11111111-aaaa-4bbb-8ccc-000000000002'

function prompt(session: string, over: { chat?: string; turn?: string | null; midturn?: boolean } = {}) {
  const opened = openPromptRequest(db, { session, chat: over.chat ?? CHAT_A, turn: over.turn ?? 'prompt-1', midturn: over.midturn ?? false })
  expect(opened, 'a prompt request was opened').not.toBeNull()
  return opened!
}

function declared(session: string, title = 'Fix the login redirect') {
  const out = openAgentRequest(db, { session, project: 'alpha', stream: 'main', agent: 'claude-code', title })
  expect(out.ok).toBe(true)
  return (out as { ok: true; request: { id: string; short: string } }).request
}

const row = (id: string) => db.prepare(`SELECT * FROM requests WHERE id = ?`).get(id) as Record<string, unknown>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at(T0)
  db = openDb(join(scratchDir('requests-'), 'inbox.db'))
})

afterEach(() => {
  db.close()
  removeScratchDirs()
  vi.useRealTimers()
})

describe('the table', () => {
  it('is created with its three indexes and the capability column on activity', () => {
    const columns = (db.prepare(`SELECT name FROM pragma_table_info('requests')`).pluck().all() as string[]).sort()
    expect(columns).toEqual([
      'acked_at', 'ack_delivered_at', 'agent', 'chat', 'closed_at', 'filed_at', 'id', 'issue_number', 'issue_repo', 'item',
      'midturn', 'next_step', 'note', 'opened_at', 'origin', 'outcome', 'parent', 'project', 'revision', 'session', 'state',
      'stream', 'title', 'turn', 'updated_at',
    ].sort())
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'requests' AND name LIKE 'idx_%'`).pluck().all()
    expect((indexes as string[]).sort()).toEqual(['idx_requests_chat', 'idx_requests_closed', 'idx_requests_session'])
    expect(db.prepare(`SELECT name FROM pragma_table_info('activity') WHERE name = 'tracks_requests'`).pluck().get()).toBe('tracks_requests')
  })

  it('migrates twice without change', () => {
    const path = db.name
    const again = openDb(path)
    again.close()
    expect(db.prepare(`SELECT count(*) FROM pragma_table_info('requests')`).pluck().get()).toBe(25)
  })

  it('has listHostSessions return tracks_requests and started_at, and writes the flag nowhere', () => {
    present('mcp-a')
    const [host] = listHostSessions(db, 4242)
    expect(host).toMatchObject({ session: 'mcp-a', project: 'alpha', agent: 'claude-code', server_pid: process.pid })
    expect(host!.started_at).toBe(iso(T0))
    expect(host!.tracks_requests).toBeNull()
    db.prepare(`UPDATE activity SET tracks_requests = 1 WHERE session = 'mcp-a'`).run()
    expect(listHostSessions(db, 4242)[0]!.tracks_requests).toBe(1)
    // an ordinary presence write keeps whatever the column holds, and sets nothing itself
    present('mcp-a')
    expect(listHostSessions(db, 4242)[0]!.tracks_requests).toBe(1)
    present('mcp-b')
    expect(listHostSessions(db, 4242).find((s) => s.session === 'mcp-b')!.tracks_requests).toBeNull()
  })
})

describe('opening a prompt request (the hook’s door)', () => {
  it('inserts an unfiled request of origin prompt, with the presence row’s project, stream and agent', () => {
    present('mcp-a', { project: 'homelab', stream: '7-dns', agent: 'claude-code' })
    const opened = prompt('mcp-a', { turn: 'turn-9', midturn: true })
    expect(opened.short).toBe(opened.id.slice(0, 8))
    expect(opened.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(row(opened.id)).toMatchObject({
      project: 'homelab', stream: '7-dns', agent: 'claude-code', session: 'mcp-a', chat: CHAT_A, turn: 'turn-9', midturn: 1,
      origin: 'prompt', state: 'unfiled', title: '', note: '', outcome: '', next_step: '', parent: null, issue_repo: null,
      issue_number: null, item: null, revision: 1, opened_at: iso(T0), filed_at: null, updated_at: iso(T0),
      closed_at: null, acked_at: null, ack_delivered_at: null,
    })
  })

  it('writes a null turn and a null midturn when the hook has none', () => {
    present('mcp-a')
    const opened = openPromptRequest(db, { session: 'mcp-a', chat: CHAT_A })!
    expect(row(opened.id)).toMatchObject({ turn: null, midturn: null })
    const plain = openPromptRequest(db, { session: 'mcp-a', chat: CHAT_A, turn: 'p1', midturn: false })!
    expect(row(plain.id)).toMatchObject({ turn: 'p1', midturn: null })
  })

  it('opens nothing for a session that is not live, or has no presence row', () => {
    expect(openPromptRequest(db, { session: 'nobody', chat: CHAT_A })).toBeNull()
    present('mcp-a')
    endActivity(db, 'mcp-a')
    expect(openPromptRequest(db, { session: 'mcp-a', chat: CHAT_A })).toBeNull()
    present('mcp-b')
    at(T0 + 16 * MIN)
    expect(openPromptRequest(db, { session: 'mcp-b', chat: CHAT_A })).toBeNull()
    expect(db.prepare(`SELECT count(*) FROM requests`).pluck().get()).toBe(0)
  })

  it('opens nothing in a reserved project', () => {
    present('mcp-a', { project: '@sessions' })
    expect(openPromptRequest(db, { session: 'mcp-a', chat: CHAT_A })).toBeNull()
    present('mcp-b', { project: '@mesh' })
    expect(openPromptRequest(db, { session: 'mcp-b', chat: CHAT_A })).toBeNull()
  })

  it('opens nothing for a chat or turn the harness id rules reject', () => {
    present('mcp-a')
    for (const chat of ['claude:', 'claude:has space', 'claude:' + 'x'.repeat(65), 'claude:a/b', 'copilot:abc', 'abc', '']) {
      expect(openPromptRequest(db, { session: 'mcp-a', chat }), chat).toBeNull()
    }
    expect(openPromptRequest(db, { session: 'mcp-a', chat: CHAT_A, turn: 'bad turn' })).toBeNull()
    expect(openPromptRequest(db, { session: 'mcp-a', chat: CHAT_A, turn: 'x'.repeat(65) })).toBeNull()
    expect(db.prepare(`SELECT count(*) FROM requests`).pluck().get()).toBe(0)
    expect(openPromptRequest(db, { session: 'mcp-a', chat: `claude:${'x'.repeat(64)}` })).not.toBeNull()
  })

  it('caps unfiled and open requests at 50 a session and counts only those states, per session', () => {
    present('mcp-a')
    present('mcp-b')
    const ids: string[] = []
    for (let n = 0; n < 50; n++) ids.push(prompt('mcp-a').id)
    expect(openPromptRequest(db, { session: 'mcp-a', chat: CHAT_A })).toBeNull()
    expect(openAgentRequest(db, { session: 'mcp-a', project: 'alpha', stream: 'main', agent: 'claude-code', title: 'One more' }))
      .toEqual({ ok: false, reason: 'too_many_open' })
    // another session is unaffected
    expect(openPromptRequest(db, { session: 'mcp-b', chat: CHAT_B })).not.toBeNull()
    // a request filed as a reply stops counting
    expect(fileRequest(db, { session: 'mcp-a', id: ids[0]!, as: 'reply' }).ok).toBe(true)
    expect(openPromptRequest(db, { session: 'mcp-a', chat: CHAT_A })).not.toBeNull()
    expect(openPromptRequest(db, { session: 'mcp-a', chat: CHAT_A })).toBeNull()
  })
})

describe('opening an agent request', () => {
  it('inserts an open request of origin agent with the scope the tool gives, and answers its brief', () => {
    present('mcp-a')
    const out = openAgentRequest(db, {
      session: 'mcp-a', project: 'alpha', stream: '12-login', agent: 'claude-code', title: '  Fix the login redirect ',
      note: 'Reading the router.', issue: { repo: 'shariqh/agent-inbox', number: 12 },
    })
    expect(out.ok).toBe(true)
    const { request } = out as { ok: true; request: { id: string; short: string; state: string; title: string; note: string } }
    expect(request).toEqual({ id: expect.any(String), short: request.id.slice(0, 8), state: 'open', title: 'Fix the login redirect', note: 'Reading the router.' })
    expect(row(request.id)).toMatchObject({
      project: 'alpha', stream: '12-login', agent: 'claude-code', session: 'mcp-a', chat: null, turn: null, midturn: null,
      origin: 'agent', state: 'open', issue_repo: 'shariqh/agent-inbox', issue_number: 12, revision: 1,
      opened_at: iso(T0), filed_at: iso(T0), updated_at: iso(T0), closed_at: null,
    })
  })

  it('refuses a blank or over-long title and an over-long note', () => {
    present('mcp-a')
    const open = (title: string, note?: string) => () => openAgentRequest(db, { session: 'mcp-a', project: 'alpha', stream: 'main', agent: 'claude-code', title, note })
    expect(open('   ')).toThrow(/title/)
    expect(open('x'.repeat(121))).toThrow(/title/)
    expect(open('Fine', 'n'.repeat(241))).toThrow(/note/)
    expect(open('x'.repeat(120), 'n'.repeat(240))).not.toThrow()
  })

  it('refuses a reserved project', () => {
    present('mcp-a')
    expect(() => openAgentRequest(db, { session: 'mcp-a', project: '@mesh', stream: 'main', agent: 'claude-code', title: 'No' })).toThrow(/reserved/)
  })
})

describe('an id is the full uuid or a unique prefix of at least 8 characters, within the session', () => {
  it('resolves a full id and a prefix, and answers ambiguous_id and not_found', () => {
    present('mcp-a')
    present('mcp-b')
    const first = prompt('mcp-a')
    expect(resolveRequestId(db, 'mcp-a', first.id)).toEqual({ ok: true, id: first.id })
    expect(resolveRequestId(db, 'mcp-a', first.short)).toEqual({ ok: true, id: first.id })
    expect(resolveRequestId(db, 'mcp-a', first.id.slice(0, 12))).toEqual({ ok: true, id: first.id })
    // fewer than 8 characters, anything that is not an id prefix, and an unknown id
    expect(resolveRequestId(db, 'mcp-a', first.id.slice(0, 7))).toEqual({ ok: false, reason: 'not_found' })
    expect(resolveRequestId(db, 'mcp-a', '')).toEqual({ ok: false, reason: 'not_found' })
    expect(resolveRequestId(db, 'mcp-a', '%%%%%%%%')).toEqual({ ok: false, reason: 'not_found' })
    expect(resolveRequestId(db, 'mcp-a', first.short.toUpperCase())).toEqual({ ok: false, reason: 'not_found' })
    expect(resolveRequestId(db, 'mcp-a', 'ffffffff')).toEqual({ ok: false, reason: 'not_found' })
    expect(resolveRequestId(db, 'mcp-a', `${first.id}0`)).toEqual({ ok: false, reason: 'not_found' })
    // another session's request reads not_found, by full id and by prefix
    expect(resolveRequestId(db, 'mcp-b', first.id)).toEqual({ ok: false, reason: 'not_found' })
    expect(resolveRequestId(db, 'mcp-b', first.short)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('answers ambiguous_id for a prefix two of the session’s requests share, whatever their states, and still takes the full id', () => {
    present('mcp-a')
    present('mcp-b')
    db.prepare(`INSERT INTO requests (id, project, session, origin, state, opened_at, updated_at) VALUES
      ('abcdef01-0000-4000-8000-000000000001', 'alpha', 'mcp-a', 'prompt', 'unfiled', ?, ?),
      ('abcdef01-0000-4000-8000-000000000002', 'alpha', 'mcp-a', 'prompt', 'done', ?, ?),
      ('abcdef01-0000-4000-8000-000000000003', 'alpha', 'mcp-b', 'prompt', 'unfiled', ?, ?)`)
      .run(...Array(6).fill(iso(T0)))
    expect(resolveRequestId(db, 'mcp-a', 'abcdef01')).toEqual({ ok: false, reason: 'ambiguous_id' })
    expect(resolveRequestId(db, 'mcp-a', 'abcdef01-0000-4000')).toEqual({ ok: false, reason: 'ambiguous_id' })
    expect(resolveRequestId(db, 'mcp-a', 'abcdef01-0000-4000-8000-000000000001')).toEqual({ ok: true, id: 'abcdef01-0000-4000-8000-000000000001' })
    // the other session has only one: its prefix is unique there
    expect(resolveRequestId(db, 'mcp-b', 'abcdef01')).toEqual({ ok: true, id: 'abcdef01-0000-4000-8000-000000000003' })
  })
})

describe('listSessionRequests (what pending() hands a session)', () => {
  it('lists this session’s unfiled and open requests, oldest first, and no other state or session', () => {
    present('mcp-a')
    present('mcp-b')
    const first = prompt('mcp-a')
    at(T0 + MIN)
    const second = declared('mcp-a', 'Write the release notes')
    at(T0 + 2 * MIN)
    const reply = prompt('mcp-a')
    fileRequest(db, { session: 'mcp-a', id: reply.id, as: 'reply' })
    prompt('mcp-b')
    expect(listSessionRequests(db, 'mcp-a')).toEqual({
      requests: [
        { id: first.id, short: first.short, state: 'unfiled', title: '', note: '', origin: 'prompt', opened_at: iso(T0), updated_at: iso(T0) },
        { id: second.id, short: second.short, state: 'open', title: 'Write the release notes', note: '', origin: 'agent', opened_at: iso(T0 + MIN), updated_at: iso(T0 + MIN) },
      ],
      more: 0,
    })
  })

  it('shows the issue as owner/name#N when one is set', () => {
    present('mcp-a')
    openAgentRequest(db, { session: 'mcp-a', project: 'alpha', stream: 'main', agent: 'claude-code', title: 'Linked', issue: { repo: 'shariqh/agent-inbox', number: 612 } })
    expect(listSessionRequests(db, 'mcp-a').requests[0]).toMatchObject({ issue: 'shariqh/agent-inbox#612' })
    at(T0 + MIN)
    prompt('mcp-a')
    expect('issue' in listSessionRequests(db, 'mcp-a').requests[1]!).toBe(false)
  })

  it('carries at most 20, oldest first, and counts the rest in more', () => {
    present('mcp-a')
    const ids: string[] = []
    for (let n = 0; n < 23; n++) {
      at(T0 + n * 1000)
      ids.push(prompt('mcp-a').id)
    }
    const page = listSessionRequests(db, 'mcp-a')
    expect(page.requests.map((r) => r.id)).toEqual(ids.slice(0, 20))
    expect(page.more).toBe(3)
  })
})

describe('file', () => {
  it('as new: unfiled becomes open with the title, optional issue and note, and stamps filed_at and the revision', () => {
    present('mcp-a')
    const opened = prompt('mcp-a')
    at(T0 + MIN)
    const out = fileRequest(db, { session: 'mcp-a', id: opened.short, as: 'new', title: ' Fix the redirect ', note: 'Starting.', issue: { repo: 'shariqh/agent-inbox', number: 12 } })
    expect(out).toEqual({ ok: true, request: { id: opened.id, short: opened.short, state: 'open', title: 'Fix the redirect', note: 'Starting.' } })
    expect(row(opened.id)).toMatchObject({
      state: 'open', title: 'Fix the redirect', note: 'Starting.', issue_repo: 'shariqh/agent-inbox', issue_number: 12,
      filed_at: iso(T0 + MIN), updated_at: iso(T0 + MIN), closed_at: null, revision: 2,
    })
  })

  it('as new needs a title', () => {
    present('mcp-a')
    const opened = prompt('mcp-a')
    expect(fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'new' })).toEqual({ ok: false, reason: 'title_required' })
    expect(fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'new', title: '   ' })).toEqual({ ok: false, reason: 'title_required' })
    expect(row(opened.id)).toMatchObject({ state: 'unfiled', revision: 1 })
  })

  it('as reply closes at once: state reply, closed_at set, never shown', () => {
    present('mcp-a')
    const opened = prompt('mcp-a')
    at(T0 + MIN)
    expect(fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'reply' })).toMatchObject({ ok: true, request: { state: 'reply' } })
    expect(row(opened.id)).toMatchObject({ state: 'reply', filed_at: iso(T0 + MIN), closed_at: iso(T0 + MIN), revision: 2 })
    expect(listSessionRequests(db, 'mcp-a').requests).toEqual([])
  })

  it('as part_of merges into an open request of this session: state merged, parent set, closed, and the parent’s note and updated_at move', () => {
    present('mcp-a')
    const parent = declared('mcp-a')
    const opened = prompt('mcp-a')
    at(T0 + 5 * MIN)
    const out = fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'part_of', parent: parent.short, note: 'Also handle the logout redirect.' })
    expect(out).toMatchObject({ ok: true, request: { id: opened.id, state: 'merged' } })
    expect(row(opened.id)).toMatchObject({ state: 'merged', parent: parent.id, closed_at: iso(T0 + 5 * MIN), filed_at: iso(T0 + 5 * MIN) })
    expect(row(parent.id)).toMatchObject({ note: 'Also handle the logout redirect.', updated_at: iso(T0 + 5 * MIN), revision: 2, state: 'open' })
  })

  it('as part_of without a note leaves the parent’s note and still moves its updated_at', () => {
    present('mcp-a')
    const parent = declared('mcp-a')
    updateRequest(db, { session: 'mcp-a', id: parent.id, note: 'Halfway.' })
    const opened = prompt('mcp-a')
    at(T0 + 5 * MIN)
    fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'part_of', parent: parent.id })
    expect(row(parent.id)).toMatchObject({ note: 'Halfway.', updated_at: iso(T0 + 5 * MIN) })
  })

  it('as part_of needs a parent that is an open request of this session', () => {
    present('mcp-a')
    present('mcp-b')
    const opened = prompt('mcp-a')
    const unfiledParent = prompt('mcp-a')
    const otherSession = declared('mcp-b')
    const closed = declared('mcp-a', 'Closed one')
    closeRequest(db, { session: 'mcp-a', id: closed.id, outcome: 'Done.' })
    for (const parent of [undefined, 'ffffffff', unfiledParent.id, otherSession.id, closed.id, opened.id]) {
      expect(fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'part_of', parent }), String(parent)).toEqual({ ok: false, reason: 'parent_not_open' })
    }
    expect(row(opened.id)).toMatchObject({ state: 'unfiled', parent: null, revision: 1 })
  })

  it('as part_of with an ambiguous parent prefix answers ambiguous_id', () => {
    present('mcp-a')
    db.prepare(`INSERT INTO requests (id, project, session, origin, state, title, opened_at, updated_at) VALUES
      ('abcdef01-0000-4000-8000-000000000001', 'alpha', 'mcp-a', 'agent', 'open', 'A', ?, ?),
      ('abcdef01-0000-4000-8000-000000000002', 'alpha', 'mcp-a', 'agent', 'open', 'B', ?, ?)`).run(...Array(4).fill(iso(T0)))
    const opened = prompt('mcp-a')
    expect(fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'part_of', parent: 'abcdef01' })).toEqual({ ok: false, reason: 'ambiguous_id' })
  })

  it('on a request that is not unfiled answers not_unfiled with its state, and changes nothing', () => {
    present('mcp-a')
    const opened = prompt('mcp-a')
    fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'new', title: 'Once' })
    const before = row(opened.id)
    expect(fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'new', title: 'Twice' })).toEqual({ ok: false, reason: 'not_unfiled', state: 'open' })
    expect(fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'reply' })).toEqual({ ok: false, reason: 'not_unfiled', state: 'open' })
    expect(row(opened.id)).toEqual(before)
    const reply = prompt('mcp-a')
    fileRequest(db, { session: 'mcp-a', id: reply.id, as: 'reply' })
    expect(fileRequest(db, { session: 'mcp-a', id: reply.id, as: 'new', title: 'Late' })).toEqual({ ok: false, reason: 'not_unfiled', state: 'reply' })
  })

  it('reads another session’s request as not_found and ambiguity as ambiguous_id', () => {
    present('mcp-a')
    present('mcp-b')
    const opened = prompt('mcp-a')
    expect(fileRequest(db, { session: 'mcp-b', id: opened.id, as: 'reply' })).toEqual({ ok: false, reason: 'not_found' })
    expect(fileRequest(db, { session: 'mcp-b', id: opened.short, as: 'new', title: 'Mine now' })).toEqual({ ok: false, reason: 'not_found' })
    expect(row(opened.id)).toMatchObject({ state: 'unfiled', session: 'mcp-a' })
  })

  it('refuses a title over 120 characters and a note over 240', () => {
    present('mcp-a')
    const opened = prompt('mcp-a')
    expect(() => fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'new', title: 'x'.repeat(121) })).toThrow(/title/)
    expect(() => fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'new', title: 'ok', note: 'n'.repeat(241) })).toThrow(/note/)
    expect(row(opened.id)).toMatchObject({ state: 'unfiled' })
  })
})

describe('update', () => {
  it('changes the note, the title and the issue of an open request, and bumps the revision and updated_at', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    at(T0 + MIN)
    const out = updateRequest(db, { session: 'mcp-a', id: req.short, note: 'Tests written.', title: 'Fix the redirect and its tests', issue: { repo: 'shariqh/agent-inbox', number: 9 } })
    expect(out).toEqual({ ok: true, request: { id: req.id, short: req.short, state: 'open', title: 'Fix the redirect and its tests', note: 'Tests written.' } })
    expect(row(req.id)).toMatchObject({ note: 'Tests written.', issue_repo: 'shariqh/agent-inbox', issue_number: 9, updated_at: iso(T0 + MIN), revision: 2 })
  })

  it('keeps what it is not given, clears a note given as an empty string and an issue given as null', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    updateRequest(db, { session: 'mcp-a', id: req.id, note: 'First.', issue: { repo: 'shariqh/agent-inbox', number: 9 } })
    updateRequest(db, { session: 'mcp-a', id: req.id, title: 'Renamed' })
    expect(row(req.id)).toMatchObject({ title: 'Renamed', note: 'First.', issue_number: 9 })
    updateRequest(db, { session: 'mcp-a', id: req.id, note: '', issue: null })
    expect(row(req.id)).toMatchObject({ title: 'Renamed', note: '', issue_repo: null, issue_number: null })
  })

  it('writes nothing for a call that names nothing to change', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    at(T0 + MIN)
    expect(updateRequest(db, { session: 'mcp-a', id: req.id }).ok).toBe(true)
    expect(row(req.id)).toMatchObject({ revision: 1, updated_at: iso(T0) })
  })

  it('refuses any state but open with not_open and the state, and another session’s request with not_found', () => {
    present('mcp-a')
    present('mcp-b')
    const unfiled = prompt('mcp-a')
    expect(updateRequest(db, { session: 'mcp-a', id: unfiled.id, note: 'x' })).toEqual({ ok: false, reason: 'not_open', state: 'unfiled' })
    const done = declared('mcp-a')
    closeRequest(db, { session: 'mcp-a', id: done.id, outcome: 'Done.' })
    expect(updateRequest(db, { session: 'mcp-a', id: done.id, note: 'x' })).toEqual({ ok: false, reason: 'not_open', state: 'done' })
    const mine = declared('mcp-a')
    expect(updateRequest(db, { session: 'mcp-b', id: mine.id, note: 'x' })).toEqual({ ok: false, reason: 'not_found' })
    expect(row(mine.id)).toMatchObject({ note: '', revision: 1 })
  })

  it('refuses a blank title and an over-long note', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    expect(() => updateRequest(db, { session: 'mcp-a', id: req.id, title: '  ' })).toThrow(/title/)
    expect(() => updateRequest(db, { session: 'mcp-a', id: req.id, note: 'n'.repeat(241) })).toThrow(/note/)
  })
})

const SCOPE = { repo: 'shariqh/agent-inbox', issue_ref: 612, head_repo: 'shariqh/agent-inbox', repo_root: '/Users/s/Development/agent-inbox' }

describe('close', () => {
  it('as done (the default) writes a resolved outcome item in the same transaction and links it', () => {
    present('mcp-a')
    const req = declared('mcp-a', 'Write the release notes')
    at(T0 + 3 * MIN)
    const out = closeRequest(db, { session: 'mcp-a', id: req.short, outcome: 'Release notes are in CHANGELOG.md.', scope: SCOPE })
    expect(out).toEqual({ ok: true, request: { id: req.id, short: req.short, state: 'done', title: 'Write the release notes', note: '' } })
    const stored = row(req.id)
    expect(stored).toMatchObject({ state: 'done', outcome: 'Release notes are in CHANGELOG.md.', closed_at: iso(T0 + 3 * MIN), updated_at: iso(T0 + 3 * MIN), revision: 2, acked_at: null })
    const item = getItem(db, stored.item as string)!
    expect(item).toMatchObject({
      kind: 'done', title: 'Write the release notes', next_step: 'No action', outcome: 'Release notes are in CHANGELOG.md.',
      status: 'resolved', resolved_at: iso(T0 + 3 * MIN), outcome_at: iso(T0 + 3 * MIN), handoff: null, action_owner: null,
      project: 'alpha', stream: 'main', agent: 'claude-code', session: 'mcp-a',
      repo: SCOPE.repo, issue_ref: 612, head_repo: SCOPE.head_repo, repo_root: SCOPE.repo_root,
    })
    // a resolved item is in no one's attention
    expect(listOpenAsks(db)).toEqual([])
  })

  it('writes an outcome item per request, never deduped against another of the same title', () => {
    present('mcp-a')
    const one = declared('mcp-a', 'Same title')
    const two = declared('mcp-a', 'Same title')
    closeRequest(db, { session: 'mcp-a', id: one.id, outcome: 'First.' })
    closeRequest(db, { session: 'mcp-a', id: two.id, outcome: 'Second.' })
    expect(row(one.id).item).not.toBe(row(two.id).item)
    expect(listItems(db).filter((item) => item.title === 'Same title')).toHaveLength(2)
  })

  it('as dropped writes no item', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    expect(closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Not needed any more.', state: 'dropped' })).toMatchObject({ ok: true, request: { state: 'dropped' } })
    expect(row(req.id)).toMatchObject({ state: 'dropped', outcome: 'Not needed any more.', item: null, closed_at: iso(T0) })
    expect(listItems(db)).toEqual([])
  })

  it('with review: true sets review and inserts the hand-off item in the same transaction, linked and open', () => {
    present('mcp-a')
    const req = declared('mcp-a', 'Try the new login flow')
    at(T0 + MIN)
    const out = closeRequest(db, {
      session: 'mcp-a', id: req.id, outcome: 'The login flow is on the branch.', review: true, next_step: 'Sign in once and check the redirect.', scope: SCOPE,
    })
    expect(out).toMatchObject({ ok: true, request: { id: req.id, state: 'review' } })
    const stored = row(req.id)
    expect(stored).toMatchObject({ state: 'review', outcome: 'The login flow is on the branch.', next_step: 'Sign in once and check the redirect.', closed_at: iso(T0 + MIN), acked_at: null })
    const item = getItem(db, stored.item as string)!
    expect(item).toMatchObject({
      kind: 'done', handoff: 1, action_owner: 'task', status: 'open', title: 'Try the new login flow',
      detail: 'The login flow is on the branch.', next_step: 'Sign in once and check the redirect.', outcome: '',
      project: 'alpha', stream: 'main', agent: 'claude-code', session: 'mcp-a', repo: SCOPE.repo, issue_ref: 612, head_repo: SCOPE.head_repo, repo_root: SCOPE.repo_root,
    })
    expect(item.options).toBeNull()
    expect(listOpenAsks(db).map((ask) => ask.id)).toEqual([item.id])
  })

  it('with review: true needs a real next step, and refuses a dropped close, writing nothing', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    for (const next_step of [undefined, '', '   ', 'No action', 'none', 'N/A']) {
      expect(closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Done.', review: true, next_step }), String(next_step)).toEqual({ ok: false, reason: 'next_step_required' })
    }
    expect(closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Done.', review: true, next_step: 'Look at it.', state: 'dropped' }))
      .toEqual({ ok: false, reason: 'review_cannot_be_dropped' })
    expect(row(req.id)).toMatchObject({ state: 'open', item: null, revision: 1 })
    expect(listItems(db)).toEqual([])
  })

  it('ignores next_step when review is not set, and stores none', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Done.', next_step: 'Look at it.' })
    expect(row(req.id)).toMatchObject({ state: 'done', next_step: '' })
    expect(getItem(db, row(req.id).item as string)).toMatchObject({ next_step: 'No action', handoff: null })
  })

  it('on an unfiled request with a title files it as new and closes it in one transaction', () => {
    present('mcp-a')
    const opened = prompt('mcp-a')
    at(T0 + 2 * MIN)
    const out = closeRequest(db, { session: 'mcp-a', id: opened.id, outcome: 'Renamed the flag.', title: 'Rename the flag' })
    expect(out).toMatchObject({ ok: true, request: { state: 'done', title: 'Rename the flag' } })
    expect(row(opened.id)).toMatchObject({ state: 'done', title: 'Rename the flag', filed_at: iso(T0 + 2 * MIN), closed_at: iso(T0 + 2 * MIN), origin: 'prompt' })
    expect(getItem(db, row(opened.id).item as string)).toMatchObject({ title: 'Rename the flag', status: 'resolved' })
    const review = prompt('mcp-a')
    expect(closeRequest(db, { session: 'mcp-a', id: review.id, outcome: 'Ready.', title: 'A second', review: true, next_step: 'Review it.' })).toMatchObject({ ok: true, request: { state: 'review' } })
    expect(row(review.id)).toMatchObject({ filed_at: iso(T0 + 2 * MIN) })
  })

  it('on an unfiled request without a title answers title_required and changes nothing', () => {
    present('mcp-a')
    const opened = prompt('mcp-a')
    expect(closeRequest(db, { session: 'mcp-a', id: opened.id, outcome: 'Done.' })).toEqual({ ok: false, reason: 'title_required' })
    expect(closeRequest(db, { session: 'mcp-a', id: opened.id, outcome: 'Done.', title: '  ' })).toEqual({ ok: false, reason: 'title_required' })
    expect(row(opened.id)).toMatchObject({ state: 'unfiled', revision: 1 })
    expect(listItems(db)).toEqual([])
  })

  it('on an open request a title replaces the title', () => {
    present('mcp-a')
    const req = declared('mcp-a', 'First name')
    closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Done.', title: 'Better name' })
    expect(row(req.id)).toMatchObject({ title: 'Better name' })
    expect(getItem(db, row(req.id).item as string)!.title).toBe('Better name')
  })

  it('refuses a request that is not open or unfiled, with not_open and its state', () => {
    present('mcp-a')
    const done = declared('mcp-a')
    closeRequest(db, { session: 'mcp-a', id: done.id, outcome: 'Done.' })
    expect(closeRequest(db, { session: 'mcp-a', id: done.id, outcome: 'Again.' })).toEqual({ ok: false, reason: 'not_open', state: 'done' })
    const review = declared('mcp-a')
    closeRequest(db, { session: 'mcp-a', id: review.id, outcome: 'Ready.', review: true, next_step: 'Look.' })
    expect(closeRequest(db, { session: 'mcp-a', id: review.id, outcome: 'Again.' })).toEqual({ ok: false, reason: 'not_open', state: 'review' })
    const reply = prompt('mcp-a')
    fileRequest(db, { session: 'mcp-a', id: reply.id, as: 'reply' })
    expect(closeRequest(db, { session: 'mcp-a', id: reply.id, outcome: 'Again.', title: 'T' })).toEqual({ ok: false, reason: 'not_open', state: 'reply' })
    expect(listItems(db)).toHaveLength(2)
  })

  it('reads another session’s request as not_found and an ambiguous prefix as ambiguous_id', () => {
    present('mcp-a')
    present('mcp-b')
    const req = declared('mcp-a')
    expect(closeRequest(db, { session: 'mcp-b', id: req.id, outcome: 'Mine.' })).toEqual({ ok: false, reason: 'not_found' })
    expect(closeRequest(db, { session: 'mcp-b', id: req.short, outcome: 'Mine.', review: true, next_step: 'Look.' })).toEqual({ ok: false, reason: 'not_found' })
    expect(row(req.id)).toMatchObject({ state: 'open', revision: 1 })
    expect(listItems(db)).toEqual([])
  })

  it('refuses a blank or over-long outcome, a next step over 180 characters, and a title over 120', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    expect(() => closeRequest(db, { session: 'mcp-a', id: req.id, outcome: '  ' })).toThrow(/outcome/)
    expect(() => closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'o'.repeat(241) })).toThrow(/outcome/)
    expect(() => closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'ok', review: true, next_step: 'n'.repeat(181) })).toThrow(/next_step/)
    expect(() => closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'ok', title: 't'.repeat(121) })).toThrow(/title/)
    expect(row(req.id)).toMatchObject({ state: 'open' })
  })

  it('is one transaction: when the item cannot be written, the request is not closed', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    const other = declared('mcp-a', 'Second')
    db.exec(`CREATE TEMP TRIGGER no_items BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'no items today'); END`)
    expect(() => closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Done.' })).toThrow(/no items today/)
    expect(() => closeRequest(db, { session: 'mcp-a', id: other.id, outcome: 'Ready.', review: true, next_step: 'Look.' })).toThrow(/no items today/)
    expect(row(req.id)).toMatchObject({ state: 'open', item: null, closed_at: null, revision: 1 })
    expect(row(other.id)).toMatchObject({ state: 'open', item: null, closed_at: null })
    db.exec(`DROP TRIGGER no_items`)
    // a dropped close writes no item, so it is not affected
    expect(closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Done.' }).ok).toBe(true)
  })
})

describe('a review request is settled by its hand-off item', () => {
  function review(session = 'mcp-a', title = 'Try the new login flow') {
    const req = declared(session, title)
    closeRequest(db, { session, id: req.id, outcome: 'It is on the branch.', review: true, next_step: 'Sign in once.' })
    return { id: req.id, item: row(req.id).item as string }
  }

  it('acknowledgeHandoff sets the request done with acked_at and the item’s outcome to the request’s outcome', () => {
    present('mcp-a')
    const { id, item } = review()
    at(T0 + 4 * MIN)
    expect(acknowledgeHandoff(db, item)).toEqual({ ok: true })
    expect(row(id)).toMatchObject({ state: 'done', acked_at: iso(T0 + 4 * MIN), ack_delivered_at: null, revision: 3 })
    expect(getItem(db, item)).toMatchObject({ status: 'resolved', outcome: 'It is on the branch.', resolved_at: iso(T0 + 4 * MIN) })
  })

  it('acknowledgeHandoff of a hand-off no request owns still resolves it as "Acknowledged"', () => {
    const id = insertItem(db, { project: 'alpha', stream: 'main', agent: 'claude-code', kind: 'done', title: 'Plain hand-off', next_step: 'Review it.' })
    expect(acknowledgeHandoff(db, id)).toEqual({ ok: true })
    expect(getItem(db, id)).toMatchObject({ outcome: 'Acknowledged', status: 'resolved' })
  })

  it('a refused acknowledgement touches no request', () => {
    present('mcp-a')
    const { id, item } = review()
    expect(acknowledgeHandoff(db, 'no-such-item')).toEqual({ ok: false, reason: 'not_found' })
    acknowledgeHandoff(db, item)
    const before = row(id)
    expect(acknowledgeHandoff(db, item)).toEqual({ ok: false, reason: 'not_handoff' })
    expect(row(id)).toEqual(before)
  })

  it('resolveItem and dismissItem settle it to done without acked_at', () => {
    present('mcp-a')
    const resolved = review('mcp-a', 'One')
    const dismissed = review('mcp-a', 'Two')
    at(T0 + MIN)
    expect(resolveItem(db, resolved.item, 'Looked fine.')).toEqual({ ok: true })
    dismissItem(db, dismissed.item)
    expect(row(resolved.id)).toMatchObject({ state: 'done', acked_at: null, ack_delivered_at: null })
    expect(row(dismissed.id)).toMatchObject({ state: 'done', acked_at: null })
    expect(getItem(db, resolved.item)).toMatchObject({ outcome: 'Looked fine.' })
  })

  it('resolving or dismissing any other item leaves every request alone', () => {
    present('mcp-a')
    const { id } = review()
    const other = insertItem(db, { project: 'alpha', stream: 'main', agent: 'claude-code', kind: 'question', title: 'Which pool?' })
    const note = insertItem(db, { project: 'alpha', stream: 'main', agent: 'claude-code', kind: 'note', title: 'Assumed Node 24' })
    const before = row(id)
    resolveItem(db, other, 'tank')
    dismissItem(db, note)
    expect(row(id)).toEqual(before)
  })

  it('a done request’s outcome item is closed already and never settles anything again', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Done.' })
    const before = row(req.id)
    resolveItem(db, before.item as string, 'Noted.')
    expect(row(req.id)).toEqual(before)
  })

  it('a request that already settled is not changed by a later resolve of its item', () => {
    present('mcp-a')
    const { id, item } = review()
    acknowledgeHandoff(db, item)
    const before = row(id)
    at(T0 + MIN)
    resolveItem(db, item, 'Again.')
    expect(row(id)).toEqual(before)
  })
})

describe('markAcksDelivered (what pending() hands over once)', () => {
  it('hands over a request acknowledged since the last delivery, once, and stamps ack_delivered_at', () => {
    present('mcp-a')
    const req = declared('mcp-a', 'Try it')
    closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Ready.', review: true, next_step: 'Look.' })
    expect(markAcksDelivered(db, 'mcp-a')).toEqual([])
    at(T0 + MIN)
    acknowledgeHandoff(db, row(req.id).item as string)
    at(T0 + 2 * MIN)
    expect(markAcksDelivered(db, 'mcp-a')).toEqual([{ id: req.id, short: req.short, title: 'Try it', acked_at: iso(T0 + MIN) }])
    expect(row(req.id).ack_delivered_at).toBe(iso(T0 + 2 * MIN))
    at(T0 + 3 * MIN)
    expect(markAcksDelivered(db, 'mcp-a')).toEqual([])
    expect(row(req.id).ack_delivered_at).toBe(iso(T0 + 2 * MIN))
  })

  it('never hands over another session’s acknowledgement, nor a resolve or dismiss', () => {
    present('mcp-a')
    present('mcp-b')
    const acked = declared('mcp-a', 'Acked')
    closeRequest(db, { session: 'mcp-a', id: acked.id, outcome: 'Ready.', review: true, next_step: 'Look.' })
    acknowledgeHandoff(db, row(acked.id).item as string)
    const resolved = declared('mcp-b', 'Resolved')
    closeRequest(db, { session: 'mcp-b', id: resolved.id, outcome: 'Ready.', review: true, next_step: 'Look.' })
    resolveItem(db, row(resolved.id).item as string, 'Fine.')
    expect(markAcksDelivered(db, 'mcp-b')).toEqual([])
    expect(markAcksDelivered(db, 'mcp-a')).toHaveLength(1)
    expect(markAcksDelivered(db, 'mcp-a')).toEqual([])
  })
})

describe('listUnfiledRequests (what a hook may know: ids, never text)', () => {
  it('lists the unfiled requests of the given sessions, oldest first, with their turn and midturn flag, and nothing else', () => {
    present('mcp-a')
    present('mcp-b')
    present('mcp-c')
    const first = prompt('mcp-a', { turn: 'turn-1' })
    at(T0 + MIN)
    const second = prompt('mcp-b', { turn: 'turn-2', midturn: true })
    at(T0 + 2 * MIN)
    prompt('mcp-c')
    const filed = prompt('mcp-a')
    fileRequest(db, { session: 'mcp-a', id: filed.id, as: 'new', title: 'Filed already' })
    declared('mcp-a')
    expect(listUnfiledRequests(db, ['mcp-a', 'mcp-b'])).toEqual([
      { id: first.id, short: first.short, session: 'mcp-a', turn: 'turn-1', midturn: false, opened_at: iso(T0) },
      { id: second.id, short: second.short, session: 'mcp-b', turn: 'turn-2', midturn: true, opened_at: iso(T0 + MIN) },
    ])
    expect(listUnfiledRequests(db, [])).toEqual([])
    expect(listUnfiledRequests(db, ['nobody'])).toEqual([])
  })
})

describe('adoptChatRequests (the only re-address path)', () => {
  it('moves the unfiled and open requests of a chat from a session that ended to the new one, and keeps everything else about them', () => {
    present('old')
    present('new')
    const unfiled = prompt('old')
    at(T0 + MIN)
    const open = prompt('old')
    fileRequest(db, { session: 'old', id: open.id, as: 'new', title: 'Half done' })
    at(T0 + 2 * MIN)
    endActivity(db, 'old')
    at(T0 + 3 * MIN)
    expect(adoptChatRequests(db, { chat: CHAT_A, to: 'new' })).toEqual({ moved: [unfiled.id, open.id].sort() })
    expect(row(unfiled.id)).toMatchObject({ session: 'new', state: 'unfiled', chat: CHAT_A, opened_at: iso(T0), updated_at: iso(T0), revision: 2 })
    expect(row(open.id)).toMatchObject({ session: 'new', state: 'open', title: 'Half done', updated_at: iso(T0 + MIN), revision: 3 })
    expect(listSessionRequests(db, 'new').requests.map((r) => r.id)).toEqual([unfiled.id, open.id])
    expect(listSessionRequests(db, 'old').requests).toEqual([])
    // a second adoption moves nothing
    expect(adoptChatRequests(db, { chat: CHAT_A, to: 'new' })).toEqual({ moved: [] })
  })

  it('moves a request whose session has no presence row, a stale one, and one whose server process is dead', () => {
    present('new')
    const noRow = openPromptRequest(db, { session: 'gone', chat: CHAT_A })
    expect(noRow).toBeNull() // a prompt cannot open for a session without presence; seed the rows directly
    for (const [n, session] of ['gone', 'stale', 'crashed'].entries()) {
      db.prepare(`INSERT INTO requests (id, project, session, chat, origin, state, opened_at, updated_at)
                  VALUES (?, 'alpha', ?, ?, 'prompt', 'unfiled', ?, ?)`).run(`00000000-0000-4000-8000-00000000000${n}`, session, CHAT_A, iso(T0), iso(T0))
    }
    at(T0 - 20 * MIN)
    present('stale')
    at(T0)
    present('crashed', { server_pid: deadPid() })
    expect(adoptChatRequests(db, { chat: CHAT_A, to: 'new' }).moved).toHaveLength(3)
    expect(db.prepare(`SELECT session FROM requests`).pluck().all()).toEqual(['new', 'new', 'new'])
  })

  it('never takes a request from a session that is live', () => {
    present('old')
    present('new')
    const req = prompt('old')
    expect(adoptChatRequests(db, { chat: CHAT_A, to: 'new' })).toEqual({ moved: [] })
    expect(row(req.id)).toMatchObject({ session: 'old', revision: 1 })
  })

  it('takes only the chat’s own unfiled and open requests', () => {
    present('old')
    present('new')
    const mine = prompt('old', { chat: CHAT_A })
    const other = prompt('old', { chat: CHAT_B })
    const closed = prompt('old', { chat: CHAT_A })
    fileRequest(db, { session: 'old', id: closed.id, as: 'reply' })
    const done = prompt('old', { chat: CHAT_A })
    closeRequest(db, { session: 'old', id: done.id, outcome: 'Done.', title: 'Finished' })
    const review = declared('old', 'Declared')
    closeRequest(db, { session: 'old', id: review.id, outcome: 'Ready.', review: true, next_step: 'Look.' })
    endActivity(db, 'old')
    expect(adoptChatRequests(db, { chat: CHAT_A, to: 'new' })).toEqual({ moved: [mine.id] })
    for (const id of [other.id, closed.id, done.id, review.id]) expect(row(id).session, id).toBe('old')
  })

  it('moves nothing to a session that is not live, to the session a request is already on, or for a chat that is not a harness chat', () => {
    present('old')
    present('new')
    const req = prompt('old')
    endActivity(db, 'old')
    expect(adoptChatRequests(db, { chat: CHAT_A, to: 'nobody' })).toEqual({ moved: [] })
    expect(adoptChatRequests(db, { chat: CHAT_A, to: 'old' })).toEqual({ moved: [] })
    endActivity(db, 'new')
    expect(adoptChatRequests(db, { chat: CHAT_A, to: 'new' })).toEqual({ moved: [] })
    expect(adoptChatRequests(db, { chat: '', to: 'new' })).toEqual({ moved: [] })
    expect(row(req.id).session).toBe('old')
  })

  it('does not take an agent-declared request, which has no chat', () => {
    present('old')
    present('new')
    const req = declared('old')
    endActivity(db, 'old')
    expect(adoptChatRequests(db, { chat: CHAT_A, to: 'new' })).toEqual({ moved: [] })
    expect(row(req.id).session).toBe('old')
  })
})

describe('dropOrphanRequest (the viewer’s Close for a request with no chat)', () => {
  it('drops an unfiled or open request whose session is gone, with the outcome "Closed from Agent Inbox", and writes no item', () => {
    present('old')
    const unfiled = prompt('old')
    const open = declared('old')
    endActivity(db, 'old')
    at(T0 + MIN)
    expect(dropOrphanRequest(db, { id: unfiled.id, revision: 1 })).toEqual({ ok: true })
    expect(dropOrphanRequest(db, { id: open.id, revision: 1 })).toEqual({ ok: true })
    for (const id of [unfiled.id, open.id]) {
      expect(row(id)).toMatchObject({ state: 'dropped', outcome: 'Closed from Agent Inbox', closed_at: iso(T0 + MIN), revision: 2, item: null })
    }
    expect(listItems(db)).toEqual([])
  })

  it('refuses a live session, a changed revision, a request that is not unfiled or open, and an unknown id', () => {
    present('old')
    const req = declared('old')
    expect(dropOrphanRequest(db, { id: req.id, revision: 1 })).toEqual({ ok: false, reason: 'session_live' })
    endActivity(db, 'old')
    expect(dropOrphanRequest(db, { id: req.id, revision: 7 })).toEqual({ ok: false, reason: 'revision_changed' })
    expect(dropOrphanRequest(db, { id: 'no-such-request', revision: 1 })).toEqual({ ok: false, reason: 'not_found' })
    closeRequest(db, { session: 'old', id: req.id, outcome: 'Done.' })
    expect(dropOrphanRequest(db, { id: req.id, revision: 2 })).toEqual({ ok: false, reason: 'not_open' })
    expect(row(req.id)).toMatchObject({ state: 'done', outcome: 'Done.' })
  })

  it('counts a session whose server process is dead, or whose presence went stale, as gone', () => {
    present('crashed', { server_pid: deadPid() })
    const crashed = declared('crashed')
    expect(dropOrphanRequest(db, { id: crashed.id, revision: 1 })).toEqual({ ok: true })
    present('quiet')
    const quiet = declared('quiet')
    at(T0 + 16 * MIN)
    expect(dropOrphanRequest(db, { id: quiet.id, revision: 1 })).toEqual({ ok: true })
  })
})

describe('listRequests (GET /api/requests, built in PR 4)', () => {
  it('serves the unfiled, open and review ones oldest first, and the done and dropped ones closed in the last 24 hours newest first', () => {
    present('mcp-a')
    const unfiled = prompt('mcp-a')
    at(T0 + MIN)
    const open = declared('mcp-a', 'Open one')
    at(T0 + 2 * MIN)
    const review = declared('mcp-a', 'Review one')
    closeRequest(db, { session: 'mcp-a', id: review.id, outcome: 'Ready.', review: true, next_step: 'Look.' })
    at(T0 + 3 * MIN)
    const done = declared('mcp-a', 'Done one')
    closeRequest(db, { session: 'mcp-a', id: done.id, outcome: 'Finished.' })
    at(T0 + 4 * MIN)
    const dropped = declared('mcp-a', 'Dropped one')
    closeRequest(db, { session: 'mcp-a', id: dropped.id, outcome: 'Not needed.', state: 'dropped' })
    const reply = prompt('mcp-a')
    fileRequest(db, { session: 'mcp-a', id: reply.id, as: 'reply' })
    const parent = declared('mcp-a', 'Parent')
    const merged = prompt('mcp-a')
    fileRequest(db, { session: 'mcp-a', id: merged.id, as: 'part_of', parent: parent.id })
    const view = listRequests(db)
    expect(view.open.map((r) => r.id)).toEqual([unfiled.id, open.id, review.id, parent.id])
    expect(view.closed.map((r) => r.id)).toEqual([dropped.id, done.id])
    expect(view.open[2]).toMatchObject({ id: review.id, state: 'review', next_step: 'Look.', outcome: 'Ready.', item: expect.any(String) })
    expect(view.closed[0]).toMatchObject({ id: dropped.id, state: 'dropped', outcome: 'Not needed.', closed_at: iso(T0 + 4 * MIN) })
  })

  it('carries the issue as owner/name#N, the short id and the scope, and never the chat, the turn, the midturn flag or the delivery stamp', () => {
    present('mcp-a')
    const opened = prompt('mcp-a', { turn: 'turn-1', midturn: true })
    fileRequest(db, { session: 'mcp-a', id: opened.id, as: 'new', title: 'Linked', issue: { repo: 'shariqh/agent-inbox', number: 612 } })
    const [one] = listRequests(db).open
    expect(one).toMatchObject({
      id: opened.id, short: opened.short, project: 'alpha', stream: 'main', agent: 'claude-code', session: 'mcp-a', origin: 'prompt',
      state: 'open', title: 'Linked', issue: 'shariqh/agent-inbox#612', revision: 2,
    })
    for (const key of ['chat', 'turn', 'midturn', 'ack_delivered_at', 'issue_repo', 'issue_number']) expect(one, key).not.toHaveProperty(key)
    expect(JSON.stringify(listRequests(db))).not.toContain(CHAT_A)
  })

  it('drops a done or dropped request closed more than 24 hours ago, and serves at most 100 closed ones', () => {
    present('mcp-a')
    const old = declared('mcp-a', 'Old')
    closeRequest(db, { session: 'mcp-a', id: old.id, outcome: 'Done.' })
    at(T0 + DAY + MIN)
    expect(listRequests(db).closed).toEqual([])
    const ids: string[] = []
    for (let n = 0; n < 102; n++) {
      at(T0 + DAY + 2 * MIN + n * 1000)
      const req = declared('mcp-a', `Fast ${n}`)
      closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Done.', state: 'dropped' })
      ids.push(req.id)
    }
    const closed = listRequests(db).closed
    expect(closed).toHaveLength(100)
    expect(closed.map((r) => r.id)).toEqual(ids.slice(2).reverse())
  })

  it('reads a review whose item an older server resolved as done, closed when the item was', () => {
    present('mcp-a')
    const req = declared('mcp-a', 'Reviewed elsewhere')
    closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Ready.', review: true, next_step: 'Look.' })
    expect(listRequests(db).open.map((r) => r.state)).toEqual(['review'])
    at(T0 + 5 * MIN)
    // an older server's resolve names no request: only the item moves
    db.prepare(`UPDATE items SET status = 'resolved', resolved_at = ?, updated_at = ?, outcome = 'Fine.' WHERE id = ?`).run(iso(T0 + 5 * MIN), iso(T0 + 5 * MIN), row(req.id).item)
    expect(row(req.id).state).toBe('review')
    const view = listRequests(db)
    expect(view.open).toEqual([])
    expect(view.closed).toEqual([expect.objectContaining({ id: req.id, state: 'done', closed_at: iso(T0 + 5 * MIN) })])
    // and out of the window once the item closed more than 24 hours ago
    at(T0 + DAY + 6 * MIN)
    expect(listRequests(db).closed).toEqual([])
  })

  it('reads a review whose item an older server dismissed as done too', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Ready.', review: true, next_step: 'Look.' })
    at(T0 + MIN)
    db.prepare(`UPDATE items SET status = 'dismissed', updated_at = ? WHERE id = ?`).run(iso(T0 + MIN), row(req.id).item)
    expect(listRequests(db).closed).toEqual([expect.objectContaining({ id: req.id, state: 'done', closed_at: iso(T0 + MIN) })])
  })

  it('settling by this build moves closed_at to the settlement and keeps the review in Needs you until then', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Ready.', review: true, next_step: 'Look.' })
    at(T0 + 2 * MIN)
    acknowledgeHandoff(db, row(req.id).item as string)
    expect(row(req.id)).toMatchObject({ state: 'done', closed_at: iso(T0 + 2 * MIN), acked_at: iso(T0 + 2 * MIN) })
    expect(listRequests(db).closed[0]).toMatchObject({ id: req.id, state: 'done', acked_at: iso(T0 + 2 * MIN) })
  })
})

describe('retention (pruneRequests, run at every open)', () => {
  const seed = (id: string, state: string, over: Record<string, string | null> = {}) =>
    db.prepare(`INSERT INTO requests (id, project, session, origin, state, opened_at, updated_at, closed_at, item) VALUES (?, 'alpha', 'mcp-a', 'agent', ?, ?, ?, ?, ?)`)
      .run(id, state, over.opened ?? iso(T0), over.updated ?? iso(T0), over.closed ?? null, over.item ?? null)
  const ids = () => db.prepare(`SELECT id FROM requests ORDER BY id`).pluck().all()

  it('deletes done and dropped 30 days after closed_at, replies and merges after one day, unfiled and open 30 days after updated_at', () => {
    const MONTH = 30 * DAY
    const before = (ms: number) => iso(T0 - ms)
    seed('done-old', 'done', { closed: before(MONTH + 1000) })
    seed('done-new', 'done', { closed: before(MONTH - 1000) })
    seed('dropped-old', 'dropped', { closed: before(MONTH + 1000) })
    seed('dropped-new', 'dropped', { closed: before(MONTH - 1000) })
    seed('reply-old', 'reply', { closed: before(DAY + 1000) })
    seed('reply-new', 'reply', { closed: before(DAY - 1000) })
    seed('merged-old', 'merged', { closed: before(DAY + 1000) })
    seed('merged-new', 'merged', { closed: before(DAY - 1000) })
    seed('open-old', 'open', { updated: before(MONTH + 1000), opened: before(MONTH + 5000) })
    seed('open-new', 'open', { updated: before(MONTH - 1000), opened: before(MONTH + 5000) })
    seed('unfiled-old', 'unfiled', { updated: before(MONTH + 1000) })
    seed('unfiled-new', 'unfiled', { updated: before(MONTH - 1000) })
    expect(pruneRequests(db)).toBe(6)
    expect(ids()).toEqual(['done-new', 'dropped-new', 'merged-new', 'open-new', 'reply-new', 'unfiled-new'])
  })

  it('keeps a review while its item is open, and prunes it as done 30 days after the item closed', () => {
    present('mcp-a')
    const req = declared('mcp-a')
    closeRequest(db, { session: 'mcp-a', id: req.id, outcome: 'Ready.', review: true, next_step: 'Look.' })
    at(T0 + 90 * DAY)
    expect(pruneRequests(db)).toBe(0)
    expect(row(req.id)).toBeTruthy()
    // an older server resolves the item: the request still reads review, and ages from then
    db.prepare(`UPDATE items SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`).run(iso(T0 + 90 * DAY), iso(T0 + 90 * DAY), row(req.id).item)
    expect(pruneRequests(db)).toBe(0)
    at(T0 + 121 * DAY)
    expect(pruneRequests(db)).toBe(1)
  })

  it('runs at the start of every open, for a prompt and for the agent', () => {
    present('mcp-a')
    seed('done-old', 'done', { closed: iso(T0 - 31 * DAY) })
    prompt('mcp-a')
    expect(ids()).not.toContain('done-old')
    seed('reply-old', 'reply', { closed: iso(T0 - 2 * DAY) })
    declared('mcp-a')
    expect(ids()).not.toContain('reply-old')
  })

  it('does not count an open request that retention removed toward the cap', () => {
    present('mcp-a')
    for (let n = 0; n < 50; n++) seed(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, 'open', { updated: iso(T0 - 31 * DAY), opened: iso(T0 - 31 * DAY) })
    expect(openPromptRequest(db, { session: 'mcp-a', chat: CHAT_A })).not.toBeNull()
  })
})
