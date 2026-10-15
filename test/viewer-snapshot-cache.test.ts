import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  annotateBoardRow, annotateItem, archiveBoard, getBoard, getItem, insertItem,
  listBoards, listItems, markAnnotationDelivered, markHandledDelivered,
  markItemAnnotationDelivered, markReplySeen, markRowHandled, openDb,
  replyItem, resolveItem, touchActivity, unarchiveBoard, updateBoardRow,
  upsertActivity, upsertBoard,
} from '../src/store.js'
import { groupItems } from '../src/group.js'
import { createViewer } from '../src/viewer.js'
import { startLocalViewer } from '../src/viewer-network.js'

const NOW = new Date('2026-09-20T12:00:00.000Z')
const ROUTES = ['/api/items', '/api/boards', '/api/boards/archived'] as const
const SCOPE = { project: 'snapshot-cache', stream: 'topic', agent: 'test' }

describe('viewer conditional snapshots', () => {
  let directory: string
  let path: string
  let db: Database.Database
  let writer: Database.Database
  let app: ReturnType<typeof createViewer>
  let server: Server | undefined

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    directory = mkdtempSync(join(tmpdir(), 'viewer-snapshots-'))
    path = join(directory, 'inbox.db')
    db = openDb(path)
    writer = openDb(path)
    app = createViewer(db)
  })

  afterEach(async () => {
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
      server = undefined
    }
    if (writer.open) writer.close()
    if (db.open) db.close()
    rmSync(directory, { recursive: true, force: true })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function question(connection = db, title = 'Human decision') {
    return insertItem(connection, {
      ...SCOPE, kind: 'question', title, context: 'All human and agent background survives. 😀',
    })
  }

  function board(connection = db) {
    upsertBoard(connection, {
      ...SCOPE, title: 'Plan',
      rows: [
        { label: 'Approval', status: 'blocked', context: 'Complete row background.' },
        { label: 'Follow-up', status: 'tracked' },
      ],
    })
    return getBoard(connection, SCOPE.project, 'Plan')!
  }

  async function tag(route: string) {
    const response = await app.request(route)
    expect(response.status).toBe(200)
    const value = response.headers.get('etag')
    expect(value).toMatch(/^"[^"]+"$/)
    await response.text()
    return value!
  }

  function conditional(route: string, etag: string, method = 'GET') {
    return app.request(route, { method, headers: { 'If-None-Match': etag } })
  }

  async function changed(route: string, previous: string) {
    const response = await conditional(route, previous)
    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBeTruthy()
    expect(response.headers.get('etag')).not.toBe(previous)
    return { etag: response.headers.get('etag')!, body: await response.json() }
  }

  it.each(ROUTES)('returns a tagged full %s representation, then a bodyless no-store 304', async (route) => {
    const initial = await app.request(route)
    expect(initial.status).toBe(200)
    expect(initial.headers.get('content-type')).toContain('application/json')
    const etag = initial.headers.get('etag')!
    expect(etag).toMatch(/^"[^"]+"$/)
    const body = await initial.text()
    const next = await conditional(route, etag)
    expect(next.status).toBe(304)
    expect(await next.text()).toBe('')
    expect(next.headers.get('etag')).toBe(etag)
    expect(next.headers.get('cache-control')).toBe('no-store')
    expect(next.headers.get('x-inbox-boot')).toBe(initial.headers.get('x-inbox-boot'))
    const unconditional = await app.request(route)
    expect(unconditional.status).toBe(200)
    expect(await unconditional.text()).toBe(body)
  })

  it('keeps all unconditional JSON fields and independent endpoint tags', async () => {
    const emptyActive = await tag('/api/boards')
    const emptyArchived = await tag('/api/boards/archived')
    expect(emptyActive).not.toBe(emptyArchived)
    question()
    board()
    const expected = [groupItems(listItems(db)), listBoards(db), listBoards(db, { status: 'archived' })]
    for (const [index, route] of ROUTES.entries()) {
      expect(await (await app.request(route)).json()).toEqual(expected[index])
    }
    const activeTag = await tag('/api/boards')
    const archivedTag = await tag('/api/boards/archived')
    expect(activeTag).not.toBe(archivedTag)
    const current = getBoard(db, SCOPE.project, 'Plan')!
    archiveBoard(db, current.id, current.revision)
    expect(await tag('/api/boards')).toBe(emptyActive)
    expect((await conditional('/api/boards', archivedTag)).status).toBe(200)
  })

  it('matches strong, weak, wildcard, lists, and optional whitespace without conflating opaque tags', async () => {
    const etag = await tag('/api/items')
    for (const value of [etag, `W/${etag}`, '*', `"other", ${etag}`, `W/"other" , \tW/${etag} \t`, `"other,opaque", ${etag}`]) {
      const response = await conditional('/api/items', value)
      expect(response.status, value).toBe(304)
      expect(await response.text()).toBe('')
    }
    for (const value of ['"different"', 'W/"different"', '"*"', etag.slice(1, -1), `"prefix,${etag.slice(1, -1)}"`]) {
      expect((await conditional('/api/items', value)).status, value).toBe(200)
    }
  })

  it.each(ROUTES)('keeps HEAD status, validators, and boot headers correct for %s', async (route) => {
    const etag = await tag(route)
    const head = await app.request(route, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('etag')).toBe(etag)
    expect(await head.text()).toBe('')
    const unchanged = await conditional(route, etag, 'HEAD')
    expect(unchanged.status).toBe(304)
    expect(await unchanged.text()).toBe('')
    expect(unchanged.headers.get('x-inbox-boot')).toBe(head.headers.get('x-inbox-boot'))
    expect(unchanged.headers.get('cache-control')).toBe('no-store')
  })

  describe.each(['same', 'other'] as const)('%s-connection invalidation', (source) => {
    const connection = () => source === 'same' ? db : writer

    it('observes new items, replies, clears, and resolution even in the same millisecond', async () => {
      const initial = await tag('/api/items')
      const id = question(connection())
      const created = await changed('/api/items', initial)
      expect(created.body.needsYou[0].items[0].id).toBe(id)
      replyItem(connection(), id, 'Proceed')
      const replied = await changed('/api/items', created.etag)
      expect(replied.body.needsYou[0].items[0].reply).toBe('Proceed')
      expect(replyItem(connection(), id, '')).toBe(true)
      const cleared = await changed('/api/items', replied.etag)
      expect(cleared.body.needsYou[0].items[0].reply).toBeNull()
      resolveItem(connection(), id, 'Finished.')
      const resolved = await changed('/api/items', cleared.etag)
      expect(resolved.body.needsYou).toEqual([])
      expect(resolved.body.done[0].outcome).toBe('Finished.')
    })

    it('observes item annotation edits, clears, and pickup without an updated_at bump', async () => {
      const id = insertItem(db, { ...SCOPE, kind: 'note', title: 'Assumption' })
      const initial = await tag('/api/items')
      annotateItem(connection(), id, 'Human correction')
      const annotated = await changed('/api/items', initial)
      const before = getItem(connection(), id)!
      vi.setSystemTime(new Date(NOW.getTime() + 1000))
      markItemAnnotationDelivered(connection(), id, before.response_revision, 'reader')
      expect(getItem(connection(), id)!.updated_at).toBe(before.updated_at)
      const pickedUp = await changed('/api/items', annotated.etag)
      expect(pickedUp.body.notes[0].items[0].annotation_seen_by).toBe('reader')
      annotateItem(connection(), id, '')
      const cleared = await changed('/api/items', pickedUp.etag)
      expect(cleared.body.notes[0].items[0].annotation).toBe('')
    })

    it('observes reply pickup without relying on content timestamps or response revision changes', async () => {
      const id = question()
      replyItem(db, id, 'Proceed')
      const initial = await tag('/api/items')
      const before = getItem(connection(), id)!
      vi.setSystemTime(new Date(NOW.getTime() + 1000))
      markReplySeen(connection(), id, before.replied_at, before.response_revision)
      expect(getItem(connection(), id)).toMatchObject({
        updated_at: before.updated_at, response_revision: before.response_revision,
      })
      const after = await changed('/api/items', initial)
      expect(after.body.needsYou[0].items[0].reply_seen_at).toBe(new Date().toISOString())
    })

    it('observes board/row edits, annotation and handled receipts, archive and reopen', async () => {
      const first = board()
      const rowId = first.rows[0]!.id
      let currentTag = await tag('/api/boards')
      const archivedTag = await tag('/api/boards/archived')
      updateBoardRow(connection(), {
        ...SCOPE, title: 'Plan', label: 'Approval', note: 'Changed state',
        expectedBoardVersion: first.revision, expectedRevision: first.rows[0]!.revision,
      })
      currentTag = (await changed('/api/boards', currentTag)).etag
      annotateBoardRow(connection(), rowId, 'Proceed')
      currentTag = (await changed('/api/boards', currentTag)).etag
      let current = getBoard(connection(), SCOPE.project, 'Plan')!
      const beforePickup = current.rows[0]!
      vi.setSystemTime(new Date(NOW.getTime() + 1000))
      markAnnotationDelivered(connection(), rowId, beforePickup.annotated_at, 'reader', {
        row: beforePickup.revision, board: current.revision,
      })
      expect(getBoard(connection(), SCOPE.project, 'Plan')!.rows[0]!.updated_at).toBe(beforePickup.updated_at)
      const annotated = await changed('/api/boards', currentTag)
      expect(annotated.body[0].rows[0].annotation_seen_by).toBe('reader')
      markRowHandled(connection(), rowId)
      currentTag = (await changed('/api/boards', annotated.etag)).etag
      current = getBoard(connection(), SCOPE.project, 'Plan')!
      const handled = current.rows[0]!
      markHandledDelivered(connection(), rowId, handled.handled_at, 'reader', {
        row: handled.revision, board: current.revision,
      })
      currentTag = (await changed('/api/boards', currentTag)).etag
      current = getBoard(connection(), SCOPE.project, 'Plan')!
      archiveBoard(connection(), current.id, current.revision)
      expect((await changed('/api/boards', currentTag)).body).toEqual([])
      const archived = await changed('/api/boards/archived', archivedTag)
      expect(archived.body[0].rows[0].handled_seen_by).toBe('reader')
      unarchiveBoard(connection(), current.id, archived.body[0].revision)
      expect((await changed('/api/boards/archived', archived.etag)).body).toEqual([])
      expect((await (await app.request('/api/boards')).json())[0].id).toBe(current.id)
    })

    it('never publishes an old snapshot with the newer token observed after its read', async () => {
      const original = question()
      const prepare = db.prepare.bind(db)
      let inserted: string | undefined
      db.prepare = ((sql: string) => {
        const statement = prepare(sql)
        if (/SELECT \* FROM items/.test(sql)) {
          const all = statement.all.bind(statement)
          statement.all = ((...args: unknown[]) => {
            const result = all(...args)
            if (!inserted) inserted = question(connection(), 'Arrived after the snapshot read')
            return result
          }) as typeof statement.all
        }
        return statement
      }) as typeof db.prepare
      try {
        const old = await app.request('/api/items')
        const oldBody = await old.json()
        expect(oldBody.needsYou[0].items.map((item: { id: string }) => item.id)).toEqual([original])
        const next = await changed('/api/items', old.headers.get('etag')!)
        expect(next.body.needsYou[0].items.map((item: { id: string }) => item.id)).toContain(inserted)
        expect((await conditional('/api/items', next.etag)).status).toBe(304)
      } finally {
        db.prepare = prepare
      }
    })
  })

  it('does not retain an uncommitted snapshot after its transaction rolls back', async () => {
    const id = question()
    const initial = await tag('/api/items')
    let pending: Promise<Response> | undefined
    const rollback = new Error('rollback fixture')
    expect(() => db.transaction(() => {
      annotateItem(db, id, 'Uncommitted correction')
      pending = Promise.resolve(app.request('/api/items'))
      throw rollback
    })()).toThrow(rollback)
    const transient = await pending!
    const transientTag = transient.headers.get('etag')!
    expect((await transient.json()).needsYou[0].items[0].annotation).toBe('Uncommitted correction')
    expect(transientTag).not.toBe(initial)
    const restored = await changed('/api/items', transientTag)
    expect(restored.body.needsYou[0].items[0].annotation).toBeNull()
    expect(restored.etag).toBe(initial)
    expect((await conditional('/api/items', initial)).status).toBe(304)
  })

  it('observes a commit from a separate Node process sharing the WAL database', async () => {
    const initial = await tag('/api/items')
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      `import { openDb, insertItem } from './src/store.ts'
       if (!process.env.AGENT_INBOX_DB) throw new Error('missing fixture database')
       const db = openDb(process.env.AGENT_INBOX_DB)
       try {
         const id = insertItem(db, { project: 'snapshot-cache', stream: 'topic',
           agent: 'child', kind: 'question', title: 'Another process committed this' })
         process.stdout.write(JSON.stringify({ id }))
       } finally { db.close() }`,
    ], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, AGENT_INBOX_DB: path, TSX_DISABLE_CACHE: '1' },
    })
    expect(child.status, child.stderr).toBe(0)
    const { id } = JSON.parse(child.stdout)
    const updated = await changed('/api/items', initial)
    expect(updated.body.needsYou[0].items[0].id).toBe(id)
    expect((await conditional('/api/items', updated.etag)).status).toBe(304)
  })

  it('does not leak caches across viewer restart and carries the new boot ID even on 304', async () => {
    question()
    const initial = await app.request('/api/items')
    const etag = initial.headers.get('etag')!
    const boot = initial.headers.get('x-inbox-boot')
    vi.setSystemTime(new Date(NOW.getTime() + 1000))
    const restarted = createViewer(writer)
    const unchanged = await restarted.request('/api/items', { headers: { 'If-None-Match': etag } })
    expect(unchanged.status).toBe(304)
    expect(unchanged.headers.get('x-inbox-boot')).not.toBe(boot)
    expect(await unchanged.text()).toBe('')
    question(writer, 'After restart')
    const newer = await restarted.request('/api/items', { headers: { 'If-None-Match': etag } })
    expect(newer.status).toBe(200)
    expect((await newer.json()).needsYou[0].items).toHaveLength(2)
  })

  it('avoids re-reading or serializing unchanged snapshots, including query-string variants', async () => {
    question()
    board()
    const tags = await Promise.all(ROUTES.map(tag))
    const queries: string[] = []
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => { queries.push(sql); return prepare(sql) }) as typeof db.prepare
    const stringify = vi.spyOn(JSON, 'stringify')
    let serializations = 0
    try {
      for (const [index, route] of ROUTES.entries()) {
        for (let request = 0; request < 3; request++) {
          expect((await conditional(`${route}?probe=${request}`, tags[index]!)).status).toBe(304)
        }
      }
      serializations = stringify.mock.calls.length
    } finally {
      stringify.mockRestore()
      db.prepare = prepare
    }
    expect(serializations).toBe(0)
    expect(queries.filter((sql) => /\bFROM\s+(items|boards|board_rows)\b/i.test(sql))).toEqual([])
  })

  it('does not serve a cached success when database reads fail', async () => {
    const initial = await tag('/api/items')
    db.close()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await conditional('/api/items', initial)
    expect(response.status).toBe(500)
    expect(response.headers.get('etag')).toBeNull()
    expect(error).toHaveBeenCalled()
  })

  it('invalidates on same-connection schema changes instead of hiding a missing table behind cached bytes', async () => {
    question()
    const initial = await tag('/api/items')
    // A schema failure is not counted by total_changes(); this is deliberate
    // fixture instrumentation, not a production schema-mutation path.
    db.exec('DROP TABLE items')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await conditional('/api/items', initial)
    expect(response.status).toBe(500)
    expect(response.headers.get('etag')).toBeNull()
    expect(error).toHaveBeenCalled()
  })

  it('keeps activity expiry, claim decay, and effective history endings fresh without database writes', async () => {
    question()
    upsertActivity(db, { ...SCOPE, session: 'live', doing: 'Work' })
    vi.setSystemTime(new Date(NOW.getTime() + 20 * 60_000))
    touchActivity(db, 'live')
    const snapshotTag = await tag('/api/items')
    expect((await (await app.request('/api/activity')).json())[0].doing).toBe('Work')
    expect((await (await app.request('/api/activity/history')).json())[0].effective_ended_at).toBeNull()
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60_000))
    const live = await conditional('/api/activity', snapshotTag)
    expect(live.status).toBe(200)
    expect(live.headers.get('etag')).toBeNull()
    expect((await live.json())[0]).toMatchObject({ doing: 'open', idle: true })
    const history = await conditional('/api/activity/history', snapshotTag)
    expect(history.status).toBe(200)
    expect((await history.json())[0].effective_ended_at).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString())
    expect((await conditional('/api/items', snapshotTag)).status).toBe(304)
    vi.setSystemTime(new Date(NOW.getTime() + 36 * 60_000))
    expect(await (await conditional('/api/activity', snapshotTag)).json()).toEqual([])
    for (const route of ['/api/links', '/api/projects/closed']) {
      const fresh = await conditional(route, snapshotTag)
      expect(fresh.status).toBe(200)
      expect(fresh.headers.get('etag')).toBeNull()
    }
  })

  it('keeps conditional responses behind the real loopback boundary and preserves its headers', async () => {
    const id = question()
    server = startLocalViewer(app, 0)
    if (!server.listening) await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const send = (headers: Record<string, string> = {}, method = 'GET') => new Promise<{
      status: number; headers: Record<string, string | string[] | undefined>; body: string
    }>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port, path: '/api/items', method, agent: false,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }))
      })
      req.on('error', reject)
      req.end()
    })
    const first = await send()
    expect(first.body).toContain(id)
    const etag = first.headers['etag'] as string
    const unchanged = await send({ 'if-none-match': etag })
    expect(unchanged.status).toBe(304)
    expect(unchanged.body).toBe('')
    expect(unchanged.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-inbox-boot': first.headers['x-inbox-boot'],
      'x-agent-inbox-local-boundary': 'loopback-v1',
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    })
    expect((await send({ 'if-none-match': etag }, 'HEAD')).status).toBe(304)
    expect((await send({ host: `attacker.example:${port}`, 'if-none-match': etag })).status).toBe(403)
    expect((await send({ origin: 'https://attacker.example', 'if-none-match': etag })).status).toBe(403)
  })
})
