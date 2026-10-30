// Issue #411: the human's messages to one MCP session. The store's rules (who
// can be addressed, exact replays, the caps, delivery and ack only by the
// addressed session, withdraw pinned to a revision) and the viewer's routes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  ackMessage, endActivity, listActivity, listOpenMessages, listPendingMessages, listSessionMessages,
  markMessageDelivered, openDb, sendSessionMessage, upsertActivity, withdrawSessionMessage,
} from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let db: Database.Database

function present(session: string, over: { receives_messages?: boolean; project?: string } = {}) {
  upsertActivity(db, {
    session, project: over.project ?? 'alpha', stream: 'main', agent: 'claude-code', doing: 'open', idle: true, claim: false,
    receives_messages: over.receives_messages ?? true,
  })
}

beforeEach(() => {
  db = openDb(join(scratchDir('session-messages-'), 'inbox.db'))
})

afterEach(() => {
  db.close()
  removeScratchDirs()
  vi.useRealTimers()
})

describe('sending a message (store)', () => {
  it('stamps the session’s project, branch and agent at send time and starts open', () => {
    present('mcp-a', { project: 'homelab' })
    const sent = sendSessionMessage(db, { id: id(1), session: 'mcp-a', text: 'Also run the DOM tests.' })
    expect(sent).toMatchObject({ ok: true, replayed: false })
    expect(listPendingMessages(db, 'mcp-a')).toEqual([expect.objectContaining({
      id: id(1), session: 'mcp-a', project: 'homelab', stream: 'main', agent: 'claude-code', text: 'Also run the DOM tests.',
      status: 'open', revision: 1, delivered_at: null, outcome: '', closed_at: null,
    })])
  })

  it('refuses a session that is missing, ended, silent past the presence window, or cannot receive', () => {
    expect(sendSessionMessage(db, { id: id(1), session: 'nobody', text: 'hi' })).toEqual({ ok: false, reason: 'session_gone' })
    present('mcp-ended')
    endActivity(db, 'mcp-ended')
    expect(sendSessionMessage(db, { id: id(2), session: 'mcp-ended', text: 'hi' })).toEqual({ ok: false, reason: 'session_gone' })
    present('mcp-old', { receives_messages: false })
    expect(sendSessionMessage(db, { id: id(3), session: 'mcp-old', text: 'hi' })).toEqual({ ok: false, reason: 'session_cannot_receive' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-30T12:00:00Z'))
    present('mcp-quiet')
    vi.setSystemTime(Date.parse('2026-10-30T12:16:00Z'))
    expect(sendSessionMessage(db, { id: id(4), session: 'mcp-quiet', text: 'hi' })).toEqual({ ok: false, reason: 'session_gone' })
    expect(listSessionMessages(db)).toEqual({ open: [], closed: [] })
  })

  it('keeps the capability a later presence write omits, as it keeps the build', () => {
    present('mcp-a')
    upsertActivity(db, { session: 'mcp-a', project: 'alpha', stream: '', agent: 'claude-code', doing: 'Working' })
    expect(listActivity(db).find((row) => row.session === 'mcp-a')?.receives_messages).toBe(true)
    present('mcp-b', { receives_messages: false })
    expect(listActivity(db).find((row) => row.session === 'mcp-b')).not.toHaveProperty('receives_messages')
  })

  it('answers an exact replay before any other check, and refuses a reused id for anything else', () => {
    present('mcp-a')
    const first = sendSessionMessage(db, { id: id(1), session: 'mcp-a', text: 'Stop after the build.' })
    endActivity(db, 'mcp-a')
    expect(sendSessionMessage(db, { id: id(1), session: 'mcp-a', text: 'Stop after the build.' }))
      .toEqual({ ok: true, replayed: true, message: first.ok && first.message })
    expect(sendSessionMessage(db, { id: id(1), session: 'mcp-a', text: 'Something else' })).toEqual({ ok: false, reason: 'id_conflict' })
    expect(sendSessionMessage(db, { id: id(1), session: 'mcp-b', text: 'Stop after the build.' })).toEqual({ ok: false, reason: 'id_conflict' })
    expect(listSessionMessages(db).open).toHaveLength(1)
  })

  it('caps a session at 20 open messages and 8000 units of open text, and a replay of the last still succeeds', () => {
    present('mcp-a')
    for (let n = 1; n <= 20; n++) expect(sendSessionMessage(db, { id: id(n), session: 'mcp-a', text: `step ${n}` }).ok).toBe(true)
    expect(sendSessionMessage(db, { id: id(21), session: 'mcp-a', text: 'one more' })).toEqual({ ok: false, reason: 'too_many_open' })
    expect(sendSessionMessage(db, { id: id(20), session: 'mcp-a', text: 'step 20' })).toMatchObject({ ok: true, replayed: true })
    present('mcp-b')
    expect(sendSessionMessage(db, { id: id(30), session: 'mcp-b', text: 'x'.repeat(4000) }).ok).toBe(true)
    expect(sendSessionMessage(db, { id: id(31), session: 'mcp-b', text: 'y'.repeat(4000) }).ok).toBe(true)
    expect(sendSessionMessage(db, { id: id(32), session: 'mcp-b', text: 'z' })).toEqual({ ok: false, reason: 'too_much_open' })
    // a closed message no longer counts
    ackMessage(db, { id: id(30), session: 'mcp-b', outcome: 'Done.' })
    expect(sendSessionMessage(db, { id: id(32), session: 'mcp-b', text: 'z' }).ok).toBe(true)
  })

  it('prunes closed and open messages older than 30 days when a message is sent', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-09-01T12:00:00Z'))
    present('mcp-a')
    sendSessionMessage(db, { id: id(1), session: 'mcp-a', text: 'old and open' })
    sendSessionMessage(db, { id: id(2), session: 'mcp-a', text: 'old and closed' })
    ackMessage(db, { id: id(2), session: 'mcp-a', outcome: 'Done.' })
    vi.setSystemTime(Date.parse('2026-10-15T12:00:00Z'))
    present('mcp-a')
    sendSessionMessage(db, { id: id(3), session: 'mcp-a', text: 'new' })
    expect(listSessionMessages(db)).toEqual({ open: [expect.objectContaining({ id: id(3) })], closed: [] })
  })
})

describe('delivery and acknowledgement (store)', () => {
  beforeEach(() => {
    present('mcp-a')
    present('mcp-b')
    sendSessionMessage(db, { id: id(1), session: 'mcp-a', text: 'For A' })
  })

  it('delivers only to the addressed session, keeps the first stamp, and is never an acknowledgement', () => {
    expect(listPendingMessages(db, 'mcp-b')).toEqual([])
    expect(markMessageDelivered(db, id(1), 'mcp-b', 'copilot')).toBe(false)
    expect(markMessageDelivered(db, id(1), 'mcp-a', 'claude-code')).toBe(true)
    const first = listPendingMessages(db, 'mcp-a')[0]!
    expect(first).toMatchObject({ status: 'open', delivered_by: 'claude-code', delivered_at: expect.any(String) })
    expect(markMessageDelivered(db, id(1), 'mcp-a', 'subagent')).toBe(true)
    expect(listPendingMessages(db, 'mcp-a')).toEqual([first])
    expect(listOpenMessages(db, ['mcp-a', 'mcp-b'])).toEqual([{ id: id(1), session: 'mcp-a' }])
  })

  it('lets only the addressed session acknowledge it, once, with an outcome', () => {
    expect(ackMessage(db, { id: id(1), session: 'mcp-b', outcome: 'Mine now.' })).toEqual({ ok: false, reason: 'not_found' })
    expect(() => ackMessage(db, { id: id(1), session: 'mcp-a', outcome: '   ' })).toThrow(/outcome/)
    const acked = ackMessage(db, { id: id(1), session: 'mcp-a', outcome: 'Ran the DOM tests: green.' })
    expect(acked).toMatchObject({ ok: true, message: { status: 'acknowledged', outcome: 'Ran the DOM tests: green.', revision: 2 } })
    expect(ackMessage(db, { id: id(1), session: 'mcp-a', outcome: 'Again.' }))
      .toEqual({ ok: false, reason: 'not_open', status: 'acknowledged', outcome: 'Ran the DOM tests: green.' })
    expect(listPendingMessages(db, 'mcp-a')).toEqual([])
    expect(markMessageDelivered(db, id(1), 'mcp-a', 'claude-code')).toBe(false)
    expect(listSessionMessages(db).closed).toEqual([expect.objectContaining({ id: id(1), closed_at: expect.any(String) })])
  })

  it('withdraws only at the revision the human saw, and an agent then learns it was withdrawn', () => {
    expect(withdrawSessionMessage(db, id(1), 2)).toEqual({ ok: false, reason: 'revision_changed' })
    expect(withdrawSessionMessage(db, id(9), 1)).toEqual({ ok: false, reason: 'not_found' })
    expect(withdrawSessionMessage(db, id(1), 1)).toMatchObject({ ok: true, message: { status: 'withdrawn', revision: 2 } })
    expect(withdrawSessionMessage(db, id(1), 2)).toEqual({ ok: false, reason: 'not_open', status: 'withdrawn', outcome: '' })
    expect(ackMessage(db, { id: id(1), session: 'mcp-a', outcome: 'Done.' }))
      .toEqual({ ok: false, reason: 'not_open', status: 'withdrawn', outcome: '' })
    expect(listPendingMessages(db, 'mcp-a')).toEqual([])
  })
})

describe('the viewer’s message routes', () => {
  async function post(app: ReturnType<typeof createViewer>, path: string, body: unknown) {
    const response = await app.request(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: response.status, json: await response.json() as Record<string, unknown> }
  }

  it('validates a send before the store sees it, and reports a store refusal as 200 ok:false', async () => {
    const app = createViewer(db)
    present('mcp-a')
    for (const body of ['not json', {}, { id: 'nope', text: 'hi' }, { id: 'ABCDEF00-0000-4000-8000-000000000001', text: 'hi' },
      { id: id(1), text: '   ' }, { id: id(1), text: 42 }, { id: id(1), text: 'x'.repeat(4001) }]) {
      const { status, json } = await post(app, '/api/sessions/mcp-a/messages', body)
      expect([status, json.ok], JSON.stringify(body)).toEqual([400, false])
    }
    expect(listSessionMessages(db).open).toEqual([])
    expect(await post(app, '/api/sessions/mcp-z/messages', { id: id(1), text: 'hi' })).toEqual({ status: 200, json: { ok: false, reason: 'session_gone' } })
    const sent = await post(app, '/api/sessions/mcp-a/messages', { id: id(1), text: 'Also update the docs.' })
    expect(sent).toMatchObject({ status: 200, json: { ok: true, replayed: false, message: { id: id(1), session: 'mcp-a' } } })
    expect((await post(app, '/api/sessions/mcp-a/messages', { id: id(1), text: 'Also update the docs.' })).json).toMatchObject({ ok: true, replayed: true })
  })

  it('withdraws by revision, with a 400 for anything but a positive integer', async () => {
    const app = createViewer(db)
    present('mcp-a')
    sendSessionMessage(db, { id: id(1), session: 'mcp-a', text: 'Never mind' })
    for (const body of [{}, { revision: '1' }, { revision: 0 }, { revision: 1.5 }]) {
      expect((await post(app, `/api/messages/${id(1)}/withdraw`, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await post(app, `/api/messages/${id(1)}/withdraw`, { revision: 2 })).json).toEqual({ ok: false, reason: 'revision_changed' })
    expect((await post(app, `/api/messages/${id(1)}/withdraw`, { revision: 1 })).json).toMatchObject({ ok: true, message: { status: 'withdrawn' } })
  })

  it('serves open and recent closed messages as a conditional snapshot', async () => {
    const app = createViewer(db)
    present('mcp-a')
    sendSessionMessage(db, { id: id(1), session: 'mcp-a', text: 'First' })
    sendSessionMessage(db, { id: id(2), session: 'mcp-a', text: 'Second' })
    ackMessage(db, { id: id(2), session: 'mcp-a', outcome: 'Done.' })
    const first = await app.request('/api/messages')
    const body = await first.json() as { open: Array<{ id: string }>; closed: Array<{ id: string }> }
    expect([body.open.map((m) => m.id), body.closed.map((m) => m.id)]).toEqual([[id(1)], [id(2)]])
    const etag = first.headers.get('etag')!
    expect((await app.request('/api/messages', { headers: { 'If-None-Match': etag } })).status).toBe(304)
    markMessageDelivered(db, id(1), 'mcp-a', 'claude-code')
    expect((await app.request('/api/messages', { headers: { 'If-None-Match': etag } })).status).toBe(200)
  })
})
