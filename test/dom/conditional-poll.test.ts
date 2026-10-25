// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, insertItem, replyItem, touchActivity, upsertActivity, upsertBoard } from '../../src/store.js'
import { createViewer } from '../../src/viewer.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, click, expectConsoleError, freshDb, pollTick, row,
  settle, showInbox, type, useDomTest,
} from './harness.js'
import type { BootOptions } from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null; vi.unstubAllGlobals() })

// The poll's archived read is the brief (#299); the complete list is read only on demand.
const SNAPSHOTS = new Set(['/api/items', '/api/boards', '/api/boards/archived/summary'])
const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
interface Read { path: string; sent: string | null; tag: string | null; status: number }

function conditionalProxy(reads: Read[], state: { boot: string; tags: boolean; malformed?: boolean }): NonNullable<BootOptions['interceptFetch']> {
  return async (input, init, next) => {
    const path = String(input)
    const response = await next()
    // A viewer marks every response it serves; one tick reads them all (#161).
    if (!SNAPSHOTS.has(path)) {
      response.headers.set('x-inbox-boot', state.boot)
      return response
    }
    const sent = new Headers(init?.headers).get('if-none-match')
    if (path === '/api/items' && state.malformed) {
      return new Response('{"needsYou":[],"notes":[],"done":"broken"}', {
        headers: { 'content-type': 'application/json', etag: '"broken"', 'x-inbox-boot': state.boot },
      })
    }
    const body = response.status === 304 ? null : await response.text()
    const headers = new Headers(response.headers)
    // Exercise the standard client contract against real viewer payloads even
    // when the server under test predates conditional snapshot support.
    const tag = state.tags
      ? headers.get('etag') ?? (body === null ? sent : `"fixture-${createHash('sha256').update(body).digest('hex')}"`)
      : null
    if (tag) headers.set('etag', tag)
    else headers.delete('etag')
    headers.set('x-inbox-boot', state.boot)
    const status = tag && sent === tag ? 304 : response.status
    reads.push({ path, sent, tag, status })
    return new Response(status === 304 ? null : body, { status, headers })
  }
}

describe('conditional snapshot polling', () => {
  it('reuses unchanged snapshots and applies newer item/board representations', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Approval' })
    upsertBoard(db, { ...AGENT, title: 'Plan', rows: [{ label: 'Step', status: 'tracked', note: 'Original' }] })
    const reads: Read[] = []
    const state = { boot: 'same-process', tags: true }
    await bootApp(db, { interceptFetch: conditionalProxy(reads, state) })
    await showInbox()
    await pollTick()
    expect(reads.slice(-3).map((entry) => entry.status)).toEqual([304, 304, 304])
    expect(reads.slice(-3).every((entry) => entry.sent === entry.tag && entry.tag !== null)).toBe(true)
    expect(row(id)?.textContent).toContain('Approval')

    replyItem(db, id, 'Proceed')
    const board = getBoard(db, 'alpha', 'Plan')!
    upsertBoard(db, {
      ...AGENT, title: 'Plan', expectedVersion: board.revision,
      rows: [{ label: 'Step', revision: board.rows[0]!.revision, status: 'tracked', note: 'Updated' }],
    })
    await pollTick()
    // One tick's reads now finish in any order (#161), so compare them by route.
    expect(Object.fromEntries(reads.slice(-3).map((entry) => [entry.path, entry.status]))).toEqual({
      '/api/items': 200, '/api/boards': 200, '/api/boards/archived/summary': 304,
    })
    expect(document.title).toBe('Agent Inbox')
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    expect(document.querySelector('#boards .row-note')?.textContent).toContain('Updated')
  })

  it('checks a changed boot on a 304 before deciding whether a draft permits reload', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Protect this draft' })
    const reload = vi.fn()
    vi.stubGlobal('location', { hash: '', reload })
    const reads: Read[] = []
    const state = { boot: 'before', tags: true }
    await bootApp(db, { interceptFetch: conditionalProxy(reads, state) })
    await showInbox()
    click(row(id))
    await settle()
    type(answerInput(id), 'Unsent response.')
    state.boot = 'after'
    await pollTick()
    expect(reads.filter((entry) => entry.path === '/api/items').at(-1)?.status).toBe(304)
    expect(reload).not.toHaveBeenCalled()
    expect(answerInput(id)?.value).toBe('Unsent response.')
    type(answerInput(id), '')
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the full-fetch path for an older server without tags', async () => {
    db = freshDb()
    insertItem(db, { ...AGENT, kind: 'question', title: 'Legacy server' })
    const reads: Read[] = []
    await bootApp(db, { interceptFetch: conditionalProxy(reads, { boot: 'legacy', tags: false }) })
    await pollTick()
    expect(reads).toHaveLength(6)
    expect(reads.every((entry) => entry.status === 200 && entry.sent === null)).toBe(true)
    expect(document.getElementById('status')?.textContent).toBe('')
  })

  it('rejects malformed success data without poisoning the last authoritative representation', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Keep the good snapshot' })
    const reads: Read[] = []
    const state = { boot: 'stable', tags: true, malformed: false }
    await bootApp(db, { interceptFetch: conditionalProxy(reads, state) })
    await showInbox()
    const goodTag = reads.find((entry) => entry.path === '/api/items')!.tag
    state.malformed = true
    expectConsoleError(/Invalid snapshot/)
    await pollTick()
    expect(document.getElementById('status')?.textContent).toBe('disconnected')
    expect(row(id)?.textContent).toContain('Keep the good snapshot')
    state.malformed = false
    await pollTick()
    expect(reads.filter((entry) => entry.path === '/api/items').at(-1)).toMatchObject({
      sent: goodTag, status: 304,
    })
    expect(row(id)?.textContent).toContain('Keep the good snapshot')
    expect(document.getElementById('status')?.textContent).toBe('')
  })

  it('keeps snooze expiry and live claim decay current while item/board bodies are unchanged', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, session: 'live', kind: 'question', title: 'Wake when due' })
    upsertActivity(db, { ...AGENT, session: 'live', doing: 'Working', idle: false })
    const viewer = createViewer(db)
    const snoozed = await viewer.request(`/api/items/${id}/snooze`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ until: new Date(Date.now() + 5000).toISOString() }),
    })
    expect((await snoozed.json()).ok).toBe(true)
    const reads: Read[] = []
    const freshHeaders: Array<string | null> = []
    const proxy = conditionalProxy(reads, { boot: 'stable', tags: true })
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        // History revalidates its own content-hashed representation (#185); the
        // time-driven half of that is pinned in conditional-history.test.ts. The
        // sub-issue graph (#103) and the cached PR state (#288) are store-token
        // snapshots of their own.
        const path = String(input).split('?')[0]!
        if (!SNAPSHOTS.has(path) && !['/api/activity/history', '/api/issues', '/api/links'].includes(path)) {
          freshHeaders.push(new Headers(init?.headers).get('if-none-match'))
        }
        return proxy(input, init, next)
      },
    })
    await showInbox()
    expect(badgeCount()).toBe(0)
    advanceClock(31 * 60_000)
    touchActivity(db, 'live')
    await pollTick()
    expect(reads.slice(-3).every((entry) => entry.status === 304)).toBe(true)
    expect(badgeCount()).toBe(1)
    expect(row(id)?.closest('details')).toBeNull()
    expect(document.getElementById('liveStripLabel')?.textContent).toContain('1 connected · no task reported')
    expect(freshHeaders.every((header) => header === null)).toBe(true)
  })

  it('ages cached notes into History once and paints them immediately on navigation', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'note', title: 'Time-based history' })
    const reads: Read[] = []
    await bootApp(db, { interceptFetch: conditionalProxy(reads, { boot: 'stable', tags: true }) })
    click(document.querySelector('.tab[data-tab="notes"]'))
    await settle()
    expect(document.querySelector(`#notes [data-card-id="${id}"]`)).not.toBeNull()
    advanceClock(8 * 24 * 60 * 60_000)
    await pollTick()
    expect(reads.slice(-3).every((entry) => entry.status === 304)).toBe(true)
    expect(document.querySelector(`#notes [data-card-id="${id}"]`)).toBeNull()
    click(document.querySelector('.tab[data-tab="done"]'))
    await settle()
    expect(document.querySelectorAll(`#done [data-card-id="${id}"]`)).toHaveLength(1)
    await pollTick()
    expect(document.querySelectorAll(`#done [data-card-id="${id}"]`)).toHaveLength(1)
  })

  it('integrates with real viewer ETags without a conditional-response shim', async () => {
    db = freshDb()
    insertItem(db, { ...AGENT, kind: 'question', title: 'Real validators' })
    const reads: Read[] = []
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        const response = await next()
        if (SNAPSHOTS.has(String(input))) reads.push({
          path: String(input), sent: new Headers(init?.headers).get('if-none-match'),
          tag: response.headers.get('etag'), status: response.status,
        })
        return response
      },
    })
    await pollTick()
    expect(reads.slice(-3).map((entry) => entry.status)).toEqual([304, 304, 304])
    expect(reads.slice(-3).every((entry) => entry.sent === entry.tag && entry.tag !== null)).toBe(true)
  })
})
