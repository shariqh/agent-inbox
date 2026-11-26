// Slow links, step 2, the server half: GET /api/boards/tags names each active plan with a tag of
// its bytes, and GET /api/boards/plans?ids= returns only the plans a page asks for, each exactly as
// the full list carries it. The page reads only the plans whose tag changed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { annotateBoardRow, archiveBoard, getBoard, listBoards, openDb, upsertBoard } from '../src/store.js'
import type { NewBoardRow } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const BASE = Date.parse('2026-11-20T00:00:00.000Z')
let clock = 0
let db: Database.Database
let app: ReturnType<typeof createViewer>

type Tags = { plans: Array<{ id: string; tag: string }> }
type Plans = { plans: Array<{ tag: string; plan: { id: string } }> }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock = 0
  vi.setSystemTime(BASE)
  db = openDb(join(scratchDir('boards-tags-'), 'inbox.db'))
  app = createViewer(db)
})

afterEach(() => {
  if (db.open) db.close()
  removeScratchDirs()
  vi.useRealTimers()
})

function tick(): void {
  clock += 1000
  vi.setSystemTime(BASE + clock)
}

function plan(title: string, rows: NewBoardRow[] = [{ label: 'Step', status: 'tracked' }]): string {
  tick()
  upsertBoard(db, { project: 'alpha', stream: 'main', agent: 'copilot', title, rows })
  return getBoard(db, 'alpha', title)!.id
}

const json = async <T>(path: string, init?: RequestInit): Promise<{ status: number; headers: Headers; body: T }> => {
  const response = await app.request(path, init)
  return { status: response.status, headers: response.headers, body: response.status === 200 ? await response.json() as T : undefined as T }
}

const tagOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22)

describe('GET /api/boards/tags', () => {
  it('lists one entry per active plan in the full list\'s order, each tagged by that plan\'s bytes', async () => {
    plan('One')
    plan('Two')
    plan('Three')
    const full = (await json<Array<{ id: string }>>('/api/boards')).body
    const tags = await json<Tags>('/api/boards/tags')
    expect(tags.status).toBe(200)
    expect(tags.headers.get('cache-control')).toBe('no-store')
    expect(tags.body.plans.map((entry) => entry.id)).toEqual(full.map((entry) => entry.id))
    expect(tags.body.plans.map((entry) => entry.tag)).toEqual(full.map(tagOf))
    for (const { tag } of tags.body.plans) expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('is a conditional snapshot: an unchanged list answers 304 to its own tag', async () => {
    plan('One')
    const first = await app.request('/api/boards/tags')
    const etag = first.headers.get('etag')!
    expect(etag).toMatch(/^"boards-tags-/)
    const again = await app.request('/api/boards/tags', { headers: { 'If-None-Match': etag } })
    expect(again.status).toBe(304)
    expect(again.headers.get('etag')).toBe(etag)
  })

  it('a human\'s answer on one row changes exactly that plan\'s tag', async () => {
    const one = plan('One')
    const two = plan('Two', [{ label: 'Approve', status: 'blocked', note: 'Ready.', next_step: 'Approve it.', action_owner: 'approval' }])
    const three = plan('Three')
    const before = new Map((await json<Tags>('/api/boards/tags')).body.plans.map((entry) => [entry.id, entry.tag]))
    tick()
    const row = getBoard(db, 'alpha', 'Two')!.rows[0]!
    expect(annotateBoardRow(db, row.id, 'Approved.')).toBe(true)
    const after = new Map((await json<Tags>('/api/boards/tags')).body.plans.map((entry) => [entry.id, entry.tag]))
    expect(after.get(one)).toBe(before.get(one))
    expect(after.get(three)).toBe(before.get(three))
    expect(after.get(two)).not.toBe(before.get(two))
  })

  it('leaves an archived plan out', async () => {
    plan('One')
    const two = plan('Two')
    tick()
    expect(archiveBoard(db, two, getBoard(db, 'alpha', 'Two')!.revision)).toBe(true)
    const tags = (await json<Tags>('/api/boards/tags')).body.plans
    expect(tags.map((entry) => entry.id)).not.toContain(two)
    expect(tags).toHaveLength(1)
  })
})

describe('GET /api/boards/plans?ids=', () => {
  it('returns the named plans exactly as the full list carries them, in its order, with the tags the tags route reports', async () => {
    const one = plan('One')
    const two = plan('Two')
    const three = plan('Three')
    const full = (await json<Array<{ id: string }>>('/api/boards')).body
    const tags = new Map((await json<Tags>('/api/boards/tags')).body.plans.map((entry) => [entry.id, entry.tag]))
    const read = await json<Plans>(`/api/boards/plans?ids=${one},${three},${two}`)
    expect(read.status).toBe(200)
    expect(read.headers.get('cache-control')).toBe('no-store')
    expect(read.body.plans.map((entry) => entry.plan)).toEqual(full)
    for (const entry of read.body.plans) expect(entry.tag).toBe(tags.get(entry.plan.id))
    expect(read.body.plans.map((entry) => entry.plan)).toEqual(listBoards(db).map((board) => JSON.parse(JSON.stringify(board))))
  })

  it('leaves out an id that names no active plan', async () => {
    const one = plan('One')
    const two = plan('Two')
    tick()
    expect(archiveBoard(db, two, getBoard(db, 'alpha', 'Two')!.revision)).toBe(true)
    const read = await json<Plans>(`/api/boards/plans?ids=${one},${two},no-such-plan`)
    expect(read.body.plans.map((entry) => entry.plan.id)).toEqual([one])
  })

  it.each([
    ['no ids', '/api/boards/plans'],
    ['an empty list', '/api/boards/plans?ids='],
    ['an empty id', '/api/boards/plans?ids=a,,b'],
    ['a malformed id', '/api/boards/plans?ids=a%2Fb'],
    ['too many ids', `/api/boards/plans?ids=${Array.from({ length: 51 }, (_, n) => `p${n}`).join(',')}`],
  ])('refuses %s with a 400', async (_name, path) => {
    const response = await app.request(path)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error: 'ids must be 1-50 comma-separated plan ids' })
  })
})
