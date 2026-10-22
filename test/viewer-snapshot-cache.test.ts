import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { rmSync } from 'node:fs'
import { request } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  CLAIM_COLD_MS, annotateBoardRow, annotateItem, archiveBoard, dismissItem, endActivity, getBoard, getItem,
  insertItem, listBoards, listItems, markAnnotationDelivered, markHandledDelivered,
  markItemAnnotationDelivered, markReplySeen, markRowHandled, openDb, readSnapshotState,
  recordActivityCall, recordIssueFailure, replyItem, resolveItem, touchActivity, unarchiveBoard, updateBoardRow,
  upsertActivity, upsertBoard, upsertIssueSnapshot,
} from '../src/store.js'
import { groupItems } from '../src/group.js'
import { createViewer } from '../src/viewer.js'
import { startLocalViewer } from '../src/viewer-network.js'
import { facts, snapshot } from './issue-fixtures.js'
import { scratchDir } from './scratch.js'

const NOW = new Date('2026-09-20T12:00:00.000Z')
const ROUTES = ['/api/items', '/api/boards', '/api/boards/archived', '/api/issues'] as const
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
    directory = scratchDir('viewer-snapshots-')
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
    // Issue #184: with no closed items the page is the whole item list, plus an
    // empty closed-history summary.
    const page = { ...groupItems(listItems(db)), history: { total: 0, loaded: 0, before: null, older: [] } }
    // Issue #103: nothing here links an issue, so the graph is complete and empty.
    const graph = {
      version: 1, nodes: [], edges: [], roots: [], aliases: {},
      truncated: { roots: 0, ancestors: 0, children: 0, dependencies: 0, edges: 0 },
    }
    const expected = [page, listBoards(db), listBoards(db, { status: 'archived' }), graph]
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

  // issue #156: the Electron dock watcher polls every 3 seconds and needs none of
  // the closed history the default representation carries.
  describe('the dock watcher item projection', () => {
    const LEAN = '/api/items?scope=attention'

    it('serves only open questions, grouped exactly like the default needsYou', async () => {
      // The frozen clock gives every item one created_at, so equality also pins
      // that the filtered read breaks same-millisecond ties like the default read.
      const answered = question(db, 'Answered')
      question(db, 'First')
      question(db, 'Second')
      replyItem(db, answered, 'Proceed')
      insertItem(db, { ...SCOPE, project: 'another-project', kind: 'question', title: 'Elsewhere' })
      const hidden = [
        insertItem(db, { ...SCOPE, kind: 'note', title: 'Assumption' }),
        insertItem(db, { ...SCOPE, kind: 'done', title: 'Shipped' }),
        question(db, 'Resolved'),
        question(db, 'Dismissed'),
      ]
      resolveItem(db, hidden[2]!, 'Finished.')
      dismissItem(db, hidden[3]!)

      const full = await (await app.request('/api/items')).json()
      expect(full.needsYou.flatMap((group: { items: unknown[] }) => group.items)).toHaveLength(4)
      const response = await app.request(LEAN)
      expect(response.status).toBe(200)
      const wire = await response.text()
      expect(JSON.parse(wire)).toEqual({ needsYou: full.needsYou, notes: [], done: [] })
      for (const id of hidden) expect(wire).not.toContain(id)
    })

    it('keeps its own body and validator, so a 304 revalidates only its own representation', async () => {
      const id = question()
      const fullResponse = await app.request('/api/items')
      const leanResponse = await app.request(LEAN)
      const fullTag = fullResponse.headers.get('etag')!
      const leanTag = leanResponse.headers.get('etag')!
      // With nothing but an open question the two bodies differ only by the
      // default's empty closed-history summary (#184), so only distinct
      // validators keep one from revalidating the other.
      const { history, ...unpaged } = await fullResponse.json()
      expect(history).toEqual({ total: 0, loaded: 0, before: null, older: [] })
      expect(await leanResponse.json()).toEqual(unpaged)
      expect(leanTag).toMatch(/^"[^"]+"$/)
      expect(leanTag).not.toBe(fullTag)
      const own = await conditional(LEAN, leanTag)
      expect(own.status).toBe(304)
      expect(own.headers.get('cache-control')).toBe('no-store')
      expect(own.headers.get('x-inbox-boot')).toBe(leanResponse.headers.get('x-inbox-boot'))
      for (const [route, foreign, expected] of [[LEAN, fullTag, leanTag], ['/api/items', leanTag, fullTag]] as const) {
        const crossed = await conditional(route, foreign)
        expect(crossed.status, route).toBe(200)
        expect(crossed.headers.get('etag'), route).toBe(expected)
      }
      // An unrecognized scope is the default representation, not a third one.
      expect((await conditional('/api/items?scope=everything', fullTag)).status).toBe(304)

      const note = insertItem(writer, { ...SCOPE, kind: 'note', title: 'Assumption' })
      expect((await conditional(LEAN, leanTag)).status).toBe(304)
      expect((await changed('/api/items', fullTag)).body.notes[0].items[0].id).toBe(note)
      resolveItem(writer, id, 'Finished.')
      const resolved = await changed(LEAN, leanTag)
      expect(resolved.body).toEqual({ needsYou: [], notes: [], done: [] })

      const queries: string[] = []
      const prepare = db.prepare.bind(db)
      db.prepare = ((sql: string) => { queries.push(sql); return prepare(sql) }) as typeof db.prepare
      const stringify = vi.spyOn(JSON, 'stringify')
      let serializations = 0
      try {
        for (let request = 0; request < 3; request++) {
          expect((await conditional(`${LEAN}&probe=${request}`, resolved.etag)).status).toBe(304)
        }
        serializations = stringify.mock.calls.length
      } finally {
        stringify.mockRestore()
        db.prepare = prepare
      }
      expect(serializations).toBe(0)
      expect(queries.filter((sql) => /\bFROM\s+items\b/i.test(sql))).toEqual([])
    })
  })

  // Issue #185: history's bytes also change with TIME alone. An open span gains
  // its capped end once it goes cold, without any database write, so the store's
  // write tokens cannot validate it. Its validator comes from the bytes and the
  // window that selected them.
  describe('the activity history representation (issue #185)', () => {
    const SINCE = NOW.getTime() - 30 * 24 * 60 * 60_000
    const HISTORY = `/api/activity/history?since_ms=${SINCE}`

    function claim(connection = db, session = 'live') {
      upsertActivity(connection, { ...SCOPE, session, doing: 'Working' })
    }

    it('returns a tagged full representation, then a bodyless no-store 304 with the boot marker', async () => {
      claim()
      const initial = await app.request(HISTORY)
      expect(initial.status).toBe(200)
      expect(initial.headers.get('content-type')).toContain('application/json')
      expect(initial.headers.get('cache-control')).toBe('no-store')
      const etag = initial.headers.get('etag')!
      expect(etag).toMatch(/^"[^"]+"$/)
      const body = await initial.text()
      expect(JSON.parse(body).map((span: { session: string }) => span.session)).toEqual(['live'])
      for (const value of [etag, `W/${etag}`, '*', `"other", ${etag}`]) {
        const unchanged = await conditional(HISTORY, value)
        expect(unchanged.status, value).toBe(304)
        expect(await unchanged.text()).toBe('')
        expect(unchanged.headers.get('etag')).toBe(etag)
        expect(unchanged.headers.get('cache-control')).toBe('no-store')
        expect(unchanged.headers.get('x-inbox-boot')).toBe(initial.headers.get('x-inbox-boot'))
      }
      expect((await conditional(HISTORY, etag, 'HEAD')).status).toBe(304)
      expect((await conditional(HISTORY, '"other"')).status).toBe(200)
      expect(await (await app.request(HISTORY)).text()).toBe(body)
      // A malformed window is refused before any validator can answer for it.
      expect((await conditional('/api/activity/history?since_ms=not-a-number', '*')).status).toBe(400)
    })

    describe.each(['same', 'other'] as const)('%s-connection writes', (source) => {
      const connection = () => source === 'same' ? db : writer

      it('answers 200 when a span starts, is renewed, or ends', async () => {
        const initial = await tag(HISTORY)
        claim(connection())
        const started = await changed(HISTORY, initial)
        expect(started.body[0]).toMatchObject({ session: 'live', ended_at: null, effective_ended_at: null })
        expect((await conditional(HISTORY, started.etag)).status).toBe(304)
        vi.setSystemTime(new Date(NOW.getTime() + 60_000))
        recordActivityCall(connection(), 'live')
        const renewed = await changed(HISTORY, started.etag)
        expect(renewed.body[0].last_active_at).toBe(new Date().toISOString())
        endActivity(connection(), 'live')
        const ended = await changed(HISTORY, renewed.etag)
        expect(ended.body[0].ended_at).toBe(new Date().toISOString())
        expect((await conditional(HISTORY, ended.etag)).status).toBe(304)
      })
    })

    it.each([HISTORY, '/api/activity/history'])(
      'answers 200 for %s when only the clock carries an open span past its cold cutoff',
      async (url) => {
        claim()
        const lastActive = Date.now()
        const etag = await tag(url)
        const before = readSnapshotState(db)
        // Exactly at the cutoff the claim is still warm, so the bytes are unchanged.
        vi.setSystemTime(new Date(lastActive + CLAIM_COLD_MS))
        expect((await conditional(url, etag)).status).toBe(304)
        // A millisecond later nothing but time has moved: the store's write tokens
        // are identical, so a validator built from them alone would hide the cap.
        vi.setSystemTime(new Date(lastActive + CLAIM_COLD_MS + 1))
        const capped = await changed(url, etag)
        expect(readSnapshotState(db)).toEqual(before)
        expect(capped.body[0]).toMatchObject({
          ended_at: null, effective_ended_at: new Date(lastActive + CLAIM_COLD_MS).toISOString(),
        })
        // Once capped, the bytes stop moving with time and revalidate again.
        vi.setSystemTime(new Date(lastActive + 3 * CLAIM_COLD_MS))
        expect((await conditional(url, capped.etag)).status).toBe(304)
      },
    )

    it('never shares a validator between windows or project filters, even for identical bytes', async () => {
      claim()
      const urls = [
        HISTORY,
        `/api/activity/history?since_ms=${SINCE + 1}`,
        '/api/activity/history',
        `${HISTORY}&project=${SCOPE.project}`,
      ]
      const tags: string[] = []
      const bodies = new Set<string>()
      for (const url of urls) {
        const response = await app.request(url)
        tags.push(response.headers.get('etag')!)
        bodies.add(await response.text())
      }
      // The same one span answers every request, so only validators tell them apart.
      expect(bodies.size).toBe(1)
      expect(new Set(tags).size).toBe(urls.length)
      for (const [index, url] of urls.entries()) {
        expect((await conditional(url, tags[index]!)).status, url).toBe(304)
        for (const foreign of tags.filter((_, other) => other !== index)) {
          expect((await conditional(url, foreign)).status, `${url} with ${foreign}`).toBe(200)
        }
      }
      // The window is the parsed number, so another spelling of it is the same window.
      expect((await conditional(`/api/activity/history?since_ms=${SINCE}.0`, tags[0]!)).status).toBe(304)
    })

    it('never revalidates or is revalidated by another route with byte-identical JSON', async () => {
      const boards = await app.request('/api/boards')
      const history = await app.request(HISTORY)
      expect(await history.text()).toBe(await boards.text())
      const boardsTag = boards.headers.get('etag')!
      const historyTag = history.headers.get('etag')!
      expect(historyTag).toMatch(/^"[^"]+"$/)
      expect(historyTag).not.toBe(boardsTag)
      expect((await conditional(HISTORY, boardsTag)).status).toBe(200)
      expect((await conditional('/api/boards', historyTag)).status).toBe(200)
    })

    it('does not let an uncommitted read validate after its transaction rolls back', async () => {
      const initial = await tag(HISTORY)
      let pending: Promise<Response> | undefined
      const rollback = new Error('rollback fixture')
      expect(() => db.transaction(() => {
        claim()
        pending = Promise.resolve(app.request(HISTORY))
        throw rollback
      })()).toThrow(rollback)
      const transient = await pending!
      const transientTag = transient.headers.get('etag')!
      expect(await transient.json()).toHaveLength(1)
      expect(transientTag).not.toBe(initial)
      const restored = await changed(HISTORY, transientTag)
      expect(restored.body).toEqual([])
      expect(restored.etag).toBe(initial)
    })

    it('revalidates across a viewer restart while carrying the new boot marker', async () => {
      claim()
      const initial = await app.request(HISTORY)
      const etag = initial.headers.get('etag')!
      vi.setSystemTime(new Date(NOW.getTime() + 1000))
      const restarted = createViewer(writer)
      const unchanged = await restarted.request(HISTORY, { headers: { 'If-None-Match': etag } })
      expect(unchanged.status).toBe(304)
      expect(unchanged.headers.get('x-inbox-boot')).not.toBe(initial.headers.get('x-inbox-boot'))
      expect(await unchanged.text()).toBe('')
    })

    it('never answers a failed read with a cached success', async () => {
      claim()
      const etag = await tag(HISTORY)
      db.close()
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      for (const value of [etag, '*']) {
        const response = await conditional(HISTORY, value)
        expect(response.status, value).toBe(500)
        expect(response.headers.get('etag')).toBeNull()
      }
      expect(error).toHaveBeenCalled()
    })
  })

  // Issue #103 (PR1a): the sub-issue graph is a sixth retained representation.
  // Its bytes depend on the database alone, so the store tokens validate it;
  // and no other representation carries GitHub data, so snapshot writes can
  // never change their bytes.
  describe('the issue graph representation (issue #103)', () => {
    const ISSUES = '/api/issues'
    const KEY = { repo: 'shariqh/agent-inbox', number: 120 }
    const started = (minutes = 0) => new Date(NOW.getTime() + minutes * 60_000).toISOString()

    function linked(connection = db, issue = 120) {
      return insertItem(connection, {
        ...SCOPE, kind: 'question', title: `About #${issue}`, repo: KEY.repo, issue_ref: issue,
      })
    }

    function cache(connection = db, minutes = 0) {
      return upsertIssueSnapshot(connection, {
        ...KEY,
        startedAt: started(minutes),
        snapshot: snapshot('shariqh/agent-inbox#120', {
          ancestors: [facts('shariqh/agent-inbox#117', { children_total: 10, children_completed: 0 })],
        }),
      })
    }

    it('serves the complete empty v1 graph until something is cached', async () => {
      linked()
      expect(await (await app.request(ISSUES)).json()).toEqual({
        version: 1, nodes: [], edges: [], roots: [], aliases: {},
        truncated: { roots: 0, ancestors: 0, children: 0, dependencies: 0, edges: 0 },
      })
    })

    it.each(['same', 'other'] as const)('answers 200 once a snapshot lands on the %s connection, then 304', async (source) => {
      linked()
      const initial = await tag(ISSUES)
      cache(source === 'same' ? db : writer)
      const updated = await changed(ISSUES, initial)
      expect(updated.body.roots.map((r: { key: string }) => r.key)).toEqual(['shariqh/agent-inbox#120'])
      expect(updated.body.edges).toEqual([expect.objectContaining({ from: 'shariqh/agent-inbox#117', to: 'shariqh/agent-inbox#120' })])
      expect((await conditional(ISSUES, updated.etag)).status).toBe(304)
      recordIssueFailure(writer, { ...KEY, error: 'not-found', startedAt: started(1) })
      const failed = await changed(ISSUES, updated.etag)
      expect(failed.body.nodes).toEqual([])
      expect(failed.body.roots[0]).toMatchObject({ failure: 'hard', error: 'not-found' })
    })

    it('leaves the bytes and validators of every other representation untouched by snapshot writes', async () => {
      linked()
      board()
      const others = ['/api/items', '/api/items?scope=attention', '/api/items/history', '/api/boards', '/api/boards/archived']
      const before = await Promise.all(others.map(async (route) => {
        const response = await app.request(route)
        return { route, etag: response.headers.get('etag')!, body: await response.text() }
      }))
      const issues = await tag(ISSUES)
      cache(writer)
      recordIssueFailure(writer, { ...KEY, error: 'offline', startedAt: started(1) })
      upsertIssueSnapshot(writer, { repo: 'a/x', number: 5, snapshot: snapshot('a/x#5'), startedAt: started(2) })
      for (const { route, etag, body } of before) {
        expect((await conditional(route, etag)).status, route).toBe(304)
        expect(await (await app.request(route)).text(), route).toBe(body)
      }
      expect((await conditional(ISSUES, issues)).status).toBe(200)
    })

    it('changes when what links an issue changes, with no snapshot write', async () => {
      const id = linked()
      cache()
      const shown = await tag(ISSUES)
      resolveItem(writer, id)
      const resolved = await changed(ISSUES, shown)
      expect(resolved.body.roots).toEqual([])
      expect(resolved.body.nodes).toEqual([])
    })

    it('never revalidates or is revalidated by another route', async () => {
      linked()
      cache()
      const issues = await tag(ISSUES)
      const items = await tag('/api/items')
      expect(issues).not.toBe(items)
      expect((await conditional(ISSUES, items)).status).toBe(200)
      expect((await conditional('/api/items', issues)).status).toBe(200)
    })
  })
})
