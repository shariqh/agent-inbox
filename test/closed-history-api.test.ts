// Issue #184: the default /api/items snapshot carries every open item plus the
// most recently touched closed items, with a summary of what it left out; the
// complete closed history is a separate conditional representation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  dismissItem, insertItem, listItems, listItemsPage, listOpenQuestions, openDb, replyItem, resolveItem,
  upsertActivity,
} from '../src/store.js'
import type { Item } from '../src/store.js'
import { groupItems } from '../src/group.js'
import { createViewer } from '../src/viewer.js'

const BASE = Date.parse('2026-10-01T00:00:00.000Z')
const SLICE = 50

let directory: string
let db: Database.Database

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock = 0
  vi.setSystemTime(BASE)
  directory = mkdtempSync(join(tmpdir(), 'closed-history-'))
  db = openDb(join(directory, 'inbox.db'))
})

afterEach(() => {
  if (db.open) db.close()
  rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

let clock = 0
function tick(): void {
  clock += 1000
  vi.setSystemTime(BASE + clock)
}

function flag(project: string, agent: string, kind: Item['kind'], title: string): string {
  tick()
  return insertItem(db, { project, stream: 'main', agent, kind, title, context: `Background for ${title}.` })
}

// 60 closed items over two projects and two agents, closed in creation order;
// every third one records an outcome and every fifth one is dismissed instead.
function seedClosed(count = 60): string[] {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const project = index % 2 ? 'alpha' : 'beta'
    const agent = index % 4 < 2 ? 'copilot' : 'claude'
    const id = flag(project, agent, index % 3 ? 'note' : 'question', `Closed ${index}`)
    tick()
    if (index % 5 === 4) dismissItem(db, id)
    else resolveItem(db, id, index % 3 === 0 ? `Outcome ${index}` : undefined)
    ids.push(id)
  }
  return ids
}

const touchedAt = (item: Item): string => [
  item.created_at, item.updated_at, item.resolved_at, item.outcome_at, item.replied_at,
  item.reply_seen_at, item.annotated_at, item.annotation_seen_at,
].filter((value): value is string => Boolean(value)).sort().at(-1)!
const newestTouch = (a: Item, b: Item): number => (touchedAt(a) < touchedAt(b) ? 1 : touchedAt(a) > touchedAt(b) ? -1 : 0)

describe('listItemsPage (issue #184)', () => {
  it('carries every open item and only the most recently touched closed items', () => {
    // Created first, closed last: the newest touch, though the oldest creation.
    const reopened = flag('gamma', 'copilot', 'question', 'Old question resolved today')
    const open = [
      flag('alpha', 'copilot', 'question', 'Open question'),
      flag('beta', 'claude', 'note', 'Open note'),
      flag('alpha', 'claude', 'done', 'Open milestone'),
    ]
    seedClosed()
    tick()
    resolveItem(db, reopened, 'Finally decided.')

    const page = listItemsPage(db, SLICE)
    const closed = listItems(db).filter((item) => item.status !== 'open')
    const ranked = [...closed].sort(newestTouch)
    const recent = new Set(ranked.slice(0, SLICE).map((item) => item.id))

    expect(page.items.filter((item) => item.status === 'open').map((item) => item.id).sort())
      .toEqual([...open].sort())
    expect(page.items.filter((item) => item.status !== 'open').map((item) => item.id).sort())
      .toEqual([...recent].sort())
    expect(recent.has(reopened)).toBe(true)
    // the page keeps listItems' order, so History's prefix is unchanged
    expect(page.items.map((item) => item.id))
      .toEqual(listItems(db).filter((item) => item.status === 'open' || recent.has(item.id)).map((item) => item.id))

    const omitted = ranked.slice(SLICE)
    expect(page.history.total).toBe(closed.length)
    expect(page.history.loaded).toBe(SLICE)
    expect(page.history.before).toBe(touchedAt(omitted[0]!))
    expect(omitted.every((item) => touchedAt(item) <= page.history.before!)).toBe(true)
    const expected = new Map<string, { project: string; agent: string; items: number; outcomes: number }>()
    for (const item of omitted) {
      const key = `${item.project}\u0000${item.agent}`
      const group = expected.get(key) ?? { project: item.project, agent: item.agent, items: 0, outcomes: 0 }
      group.items += 1
      if (item.outcome) group.outcomes += 1
      expected.set(key, group)
    }
    const binary = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
    expect(page.history.older).toEqual([...expected.values()]
      .sort((a, b) => binary(a.project, b.project) || binary(a.agent, b.agent)))
    expect(page.history.older.reduce((sum, group) => sum + group.items, 0)).toBe(omitted.length)
  })

  it('ranks by the latest of every recorded stamp, not updated_at alone', () => {
    const ids = seedClosed()
    const [oldest, next] = ids as [string, string]
    expect(listItemsPage(db, SLICE).items.some((item) => item.id === oldest)).toBe(false)
    // Delivery stamps never bump updated_at, and another process's clock can
    // record a later stamp. Either way the newest stamp is the item's touch, so
    // the page's boundary also bounds every omitted item's Dashboard stamp.
    const later = new Date(BASE + clock + 60_000).toISOString()
    db.prepare(`UPDATE items SET reply_seen_at = ? WHERE id = ?`).run(later, oldest)
    db.prepare(`UPDATE items SET annotation_seen_at = ? WHERE id = ?`).run(later, next)
    const page = listItemsPage(db, SLICE)
    expect(page.items.some((item) => item.id === oldest)).toBe(true)
    expect(page.items.some((item) => item.id === next)).toBe(true)
    expect(page.history.before! < later).toBe(true)
  })

  it('reports complete history when every closed item fits', () => {
    seedClosed(12)
    const page = listItemsPage(db, SLICE)
    expect(page.items).toEqual(listItems(db))
    expect(page.history).toEqual({ total: 12, loaded: 12, before: null, older: [] })
  })

  it('omits everything closed for a zero bound and still states a boundary', () => {
    seedClosed(3)
    const page = listItemsPage(db, 0)
    expect(page.items).toEqual([])
    expect(page.history.loaded).toBe(0)
    expect(page.history.before).toBe(touchedAt(listItems(db)[0]!))
  })

  it('keeps listItems order for same-millisecond ties', () => {
    // The clock never moves: every created_at ties, so only rowid orders them.
    for (let index = 0; index < 8; index += 1) {
      const id = insertItem(db, { project: 'alpha', stream: '', agent: 'copilot', kind: 'note', title: `Tie ${index}` })
      if (index % 2) resolveItem(db, id)
    }
    expect(listItemsPage(db, SLICE).items.map((item) => item.id)).toEqual(listItems(db).map((item) => item.id))
    const page = listItemsPage(db, 2)
    const kept = new Set(page.items.map((item) => item.id))
    expect(page.items.map((item) => item.id))
      .toEqual(listItems(db).filter((item) => kept.has(item.id)).map((item) => item.id))
  })
})

describe('viewer closed-history representations (issue #184)', () => {
  function tag(response: Response): string {
    const value = response.headers.get('etag')
    expect(value).toMatch(/^"[^"]+"$/)
    return value!
  }

  async function read(app: ReturnType<typeof createViewer>, route: string, etag?: string) {
    const response = await app.request(route, etag ? { headers: { 'If-None-Match': etag } } : undefined)
    return { status: response.status, etag: response.headers.get('etag'), body: response.status === 200 ? await response.json() : null }
  }

  it('bounds /api/items and serves the complete done list from /api/items/history', async () => {
    const question = flag('alpha', 'copilot', 'question', 'Still open')
    const milestone = flag('beta', 'claude', 'done', 'Shipped')
    seedClosed()
    const app = createViewer(db)
    const items = await read(app, '/api/items')
    const page = listItemsPage(db, SLICE)
    expect(items.body).toEqual(JSON.parse(JSON.stringify({ ...groupItems(page.items), history: page.history })))
    expect(items.body.needsYou[0].items[0].id).toBe(question)
    expect(items.body.done.filter((item: Item) => item.status !== 'open')).toHaveLength(SLICE)
    expect(items.body.done.some((item: Item) => item.id === milestone)).toBe(true)
    expect(items.body.history).toMatchObject({ total: 60, loaded: SLICE })

    const history = await read(app, '/api/items/history')
    expect(history.body).toEqual(JSON.parse(JSON.stringify({ done: groupItems(listItems(db)).done })))
    expect(history.body.done).toHaveLength(61)
    // the attention projection is untouched: no closed items and no summary
    const attention = await read(app, '/api/items?scope=attention')
    expect(attention.body).toEqual(JSON.parse(JSON.stringify(groupItems(listOpenQuestions(db)))))
    expect(attention.body).not.toHaveProperty('history')
  })

  it('validates each representation independently and never revalidates across routes', async () => {
    seedClosed()
    upsertActivity(db, { project: 'alpha', stream: 'main', agent: 'copilot', session: 'live', doing: 'Working' })
    const app = createViewer(db)
    // #184 and #185: the page, the dock watcher's projection, the complete History
    // list and activity history are four representations with four validators.
    const routes = [
      '/api/items', '/api/items?scope=attention', '/api/items/history',
      `/api/activity/history?since_ms=${BASE - 30 * 24 * 60 * 60_000}`,
    ]
    const tags: string[] = []
    for (const route of routes) tags.push(tag(await app.request(route)))
    expect(new Set(tags).size).toBe(routes.length)
    const head = await app.request('/api/items/history', { method: 'HEAD', headers: { 'If-None-Match': tags[2]! } })
    expect(head.status).toBe(304)
    expect(head.headers.get('cache-control')).toBe('no-store')
    expect(head.headers.get('x-inbox-boot')).toBeTruthy()
    // Interleaved, every route still answers its own validator and no other.
    for (const [index, route] of routes.entries()) {
      for (const [other, foreign] of tags.entries()) {
        const response = await read(app, route, foreign)
        if (other === index) {
          expect(response.status, `${route} with its own tag`).toBe(304)
        } else {
          expect(response.status, `${route} must not accept ${foreign}`).toBe(200)
          expect(response.etag).toBe(tags[index])
        }
      }
    }
  })

  it('refreshes each representation only when its own content changes', async () => {
    const question = flag('alpha', 'copilot', 'question', 'Decide')
    seedClosed()
    const app = createViewer(db)
    let items = tag(await app.request('/api/items'))
    let history = tag(await app.request('/api/items/history'))

    tick()
    replyItem(db, question, 'Proceed')
    const replied = await read(app, '/api/items', items)
    expect(replied.status).toBe(200)
    expect(replied.body.needsYou[0].items[0].reply).toBe('Proceed')
    items = replied.etag!
    // an open item's answer is not closed history
    expect((await read(app, '/api/items/history', history)).status).toBe(304)

    tick()
    resolveItem(db, question, 'Shipped it.')
    const resolved = await read(app, '/api/items', items)
    expect(resolved.status).toBe(200)
    expect(resolved.body.needsYou).toEqual([])
    expect(resolved.body.done.find((item: Item) => item.id === question)?.outcome).toBe('Shipped it.')
    const changed = await read(app, '/api/items/history', history)
    expect(changed.status).toBe(200)
    expect(changed.body.done.find((item: Item) => item.id === question)?.outcome).toBe('Shipped it.')
    history = changed.etag!
    expect((await read(app, '/api/items/history', history)).status).toBe(304)
  })
})
