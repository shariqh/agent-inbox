// @vitest-environment jsdom
// Issue #161: one poll tick issues its independent reads together, so its wall
// time is bounded by the slowest read rather than the sum of all seven. The
// tick's safety rules must survive that: an older tick never overwrites a newer
// one, each read degrades exactly as it did when the reads were serial, and a
// viewer restart between two reads of one tick never mixes two servers' data.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertBoard } from '../../src/store.js'
import {
  answerInput, badgeCount, bootApp, click, expectConsoleError, freshDb, pollTick, row,
  settle, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null; vi.unstubAllGlobals() })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const POLL_READS = [
  '/api/activity', '/api/activity/history', '/api/boards', '/api/boards/archived',
  '/api/items', '/api/links', '/api/projects/closed',
]
const route = (input: RequestInfo | URL): string => String(input).split('?')[0]!
const isGet = (init: RequestInit | undefined): boolean => (init?.method ?? 'GET') === 'GET'
const status = (): string | null | undefined => document.getElementById('status')?.textContent

async function showBoards(): Promise<void> {
  click(document.querySelector('.tab[data-tab="boards"]'))
  await settle()
}

describe('concurrent poll reads (issue #161)', () => {
  it('starts every read of one tick before any of them answers', async () => {
    db = freshDb()
    insertItem(db, { ...AGENT, kind: 'question', title: 'Already here' })
    const started: string[] = []
    let gate: Promise<void> | null = null
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (gate && isGet(init)) {
          started.push(route(input))
          await gate
        }
        return next()
      },
    })
    await showInbox()
    let release!: () => void
    gate = new Promise<void>((resolve) => { release = resolve })
    const later = insertItem(db, { ...AGENT, kind: 'question', title: 'Arrives with the held tick' })

    await pollTick()
    expect([...started].sort()).toEqual(POLL_READS)
    expect(row(later)).toBeNull()

    gate = null
    release()
    await settle()
    expect(row(later)?.textContent).toContain('Arrives with the held tick')
    expect(status()).toBe('')
  })

  it('never lets an older, slower tick overwrite a newer one', async () => {
    db = freshDb()
    insertItem(db, { ...AGENT, kind: 'question', title: 'First' })
    let holding = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        const held = holding && isGet(init)
        const response = await next()
        if (held) await gate
        return response
      },
    })
    await showInbox()
    // The older tick reads this state, then stalls before it can apply it.
    const stale = insertItem(db, { ...AGENT, kind: 'question', title: 'Read by the older tick' })
    holding = true
    await pollTick()
    holding = false

    const fresh = insertItem(db, { ...AGENT, kind: 'question', title: 'Read by the newer tick' })
    await pollTick()
    expect(row(stale)).not.toBeNull()
    expect(row(fresh)).not.toBeNull()
    expect(badgeCount()).toBe(3)

    release()
    await settle()
    expect(row(fresh)?.textContent).toContain('Read by the newer tick')
    expect(badgeCount()).toBe(3)
    await pollTick()
    expect(row(fresh)?.textContent).toContain('Read by the newer tick')
    expect(badgeCount()).toBe(3)
  })

  it('degrades failed history, closed-project and link reads exactly as before', async () => {
    db = freshDb()
    let failing = false
    await bootApp(db, {
      interceptFetch: async (input, _init, next) => {
        if (failing && route(input) === '/api/activity/history') return new Response('unavailable', { status: 503 })
        if (failing && route(input) === '/api/projects/closed') throw new TypeError('closed projects offline')
        if (failing && route(input) === '/api/links') return new Response('<!doctype html>', { status: 404 })
        return next()
      },
    })
    failing = true
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Still arrives' })
    upsertBoard(db, { ...AGENT, title: 'Rollout', rows: [{ label: 'Step', status: 'tracked', note: 'Still current' }] })

    await pollTick()
    expect(status()).toBe('')
    await showInbox()
    expect(row(id)?.textContent).toContain('Still arrives')
    await showBoards()
    expect(document.querySelector('#boards .row-note')?.textContent).toContain('Still current')
  })

  it('keeps the established frame when the activity read fails, then recovers', async () => {
    db = freshDb()
    const first = insertItem(db, { ...AGENT, kind: 'question', title: 'Established' })
    let failing = false
    await bootApp(db, {
      interceptFetch: async (input, _init, next) => {
        if (failing && route(input) === '/api/activity') throw new TypeError('activity offline')
        return next()
      },
    })
    await showInbox()
    failing = true
    expectConsoleError(/activity offline/)
    const second = insertItem(db, { ...AGENT, kind: 'question', title: 'After the outage' })

    await pollTick()
    expect(status()).toBe('disconnected')
    expect(row(first)?.textContent).toContain('Established')
    expect(row(second)).toBeNull()

    failing = false
    await pollTick()
    expect(status()).toBe('')
    expect(row(second)?.textContent).toContain('After the outage')
  })
})

describe('a viewer restart inside one tick (issue #161)', () => {
  function stubReload(): ReturnType<typeof vi.fn> {
    const reload = vi.fn()
    vi.stubGlobal('location', { hash: '', reload })
    return reload
  }

  async function bootTagged(d: Database.Database): Promise<{ tag(marker: (path: string) => string): void }> {
    let marker = (_path: string): string => 'original-viewer'
    await bootApp(d, {
      interceptFetch: async (input, _init, next) => {
        const response = await next()
        response.headers.set('x-inbox-boot', marker(route(input)))
        return response
      },
    })
    return { tag(next) { marker = next } }
  }

  it('reloads when the reads of one tick come from two server instances', async () => {
    const reload = stubReload()
    db = freshDb()
    const viewer = await bootTagged(db)
    viewer.tag((path) => (path === '/api/boards' ? 'restarted-viewer' : 'original-viewer'))
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('never applies a mixed tick while protected work defers the reload', async () => {
    const reload = stubReload()
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Protect this draft' })
    const viewer = await bootTagged(db)
    await showInbox()
    click(row(id))
    await settle()
    type(answerInput(id), 'Unsent answer.')
    insertItem(db, { ...AGENT, kind: 'question', title: 'Arrived across the restart' })

    viewer.tag((path) => (path === '/api/items' ? 'original-viewer' : 'restarted-viewer'))
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    expect(badgeCount()).toBe(1)
    expect(answerInput(id)?.value).toBe('Unsent answer.')

    viewer.tag(() => 'restarted-viewer')
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    expect(badgeCount()).toBe(2)
    expect(answerInput(id)?.value).toBe('Unsent answer.')
    expect(document.getElementById('pauseHint')?.textContent).toContain('Viewer updated')

    type(answerInput(id), '')
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
