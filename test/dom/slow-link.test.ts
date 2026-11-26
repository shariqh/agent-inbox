// @vitest-environment jsdom
// Slow links, step 1, the page half: the real public/app.js on fake timers, its reads bridged
// onto the real viewer app. One round runs at a time, so a body slower than several 3 s ticks is
// read once and its tag is stored for the next round (public/snapshots.js keeps only the newest
// request's tag), and a read that stops arriving ends the round the way a network error does.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, insertItem, upsertBoard } from '../../src/store.js'
import { STALL_MS } from '../../public/stall.js'
import { badgeCount, bootApp, click, expectConsoleError, freshDb, pollTick, row, settle, showInbox, useDomTest } from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const route = (input: RequestInfo | URL): string => String(input).split('?')[0]!
const isGet = (init: RequestInit | undefined): boolean => (init?.method ?? 'GET') === 'GET'
const status = (): string | null | undefined => document.getElementById('status')?.textContent

/** The same answer, its body handed out in `parts` pieces, one every `everyMs`. */
async function slowly(response: Response, parts: number, everyMs: number): Promise<Response> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  const size = Math.ceil(bytes.length / parts)
  const body = new ReadableStream<Uint8Array>({
    start(out) {
      for (let n = 0; n < parts; n++) {
        setTimeout(() => {
          out.enqueue(bytes.slice(n * size, (n + 1) * size))
          if (n === parts - 1) out.close()
        }, (n + 1) * everyMs)
      }
    },
  })
  return new Response(body, { status: response.status, headers: response.headers })
}

describe('one round at a time over a slow link', () => {
  // Slow links, step 2: the plans list is read as its tags, then the plans by id. The slow body is
  // now the plans read, and the tag the next round sends is the tags read's.
  it('reads a slow plans list once, and the next round revalidates it with the stored tag', async () => {
    db = freshDb()
    for (let n = 0; n < 4; n++) {
      upsertBoard(db, { ...AGENT, title: `Plan ${n}`, rows: [{ label: 'Step', status: 'tracked', note: 'the note' }] })
    }
    const tags: Array<{ ifNoneMatch: string | null; etag: string | null; status: number }> = []
    const plans: string[] = []
    let slow = true
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (!isGet(init)) return next()
        if (route(input) === '/api/boards') throw new Error('the poll read the whole plans list')
        if (route(input) === '/api/boards/tags') {
          const sent = new Headers(init?.headers)
          const response = await next()
          tags.push({ ifNoneMatch: sent.get('If-None-Match'), etag: response.headers.get('etag'), status: response.status })
          return response
        }
        if (route(input) !== '/api/boards/plans') return next()
        plans.push(String(input))
        const response = await next()
        if (!slow) return response
        slow = false
        // 5 pieces, one every 2.5 s: the body takes 12.5 s, four poll ticks, and never stalls
        return slowly(response, 5, 2_500)
      },
    })
    expect(tags).toHaveLength(1)
    expect(tags[0]!.ifNoneMatch).toBeNull()
    // the four plans fit in one read by id
    expect(plans).toHaveLength(1)

    // four ticks while the body is still arriving: none starts a read
    for (let tick = 0; tick < 4; tick++) await pollTick()
    expect(tags, 'only one tags request while the plans read was in flight').toHaveLength(1)
    expect(plans, 'only one plans request while the first was in flight').toHaveLength(1)

    // the body ends at 12.5 s; the next tick is not due until 15 s
    await vi.advanceTimersByTimeAsync(1_000)
    // the ticks shared one follow-up round, which sent the tag the tags were stored under
    expect(tags).toHaveLength(2)
    expect(tags[0]!.etag).toMatch(/^"boards-tags-/)
    expect(tags[1]!.ifNoneMatch).toBe(tags[0]!.etag)
    expect(tags[1]!.status).toBe(304)
    // and, nothing having changed, read no plan
    expect(plans).toHaveLength(1)
    expect(status()).toBe('')
  })

  it('ends a read that stops arriving after 30 s: the old frame stays, the round reads as failed, the next recovers', async () => {
    db = freshDb()
    const first = insertItem(db, { ...AGENT, kind: 'question', title: 'Established' })
    let stalled = false
    await bootApp(db, {
      interceptFetch: async (input, init, next) =>
        (stalled && isGet(init) && route(input) === '/api/items' ? new Promise<Response>(() => {}) : next()),
    })
    await showInbox()
    expectConsoleError(/TimeoutError/)
    stalled = true
    const second = insertItem(db, { ...AGENT, kind: 'question', title: 'After the outage' })

    await pollTick()
    // ticks keep coming; the round waits for its stalled read, and no other round starts
    await vi.advanceTimersByTimeAsync(STALL_MS - 1_000)
    expect(status()).toBe('')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(status()).toBe('disconnected')
    expect(row(first)?.textContent).toContain('Established')
    expect(row(second)).toBeNull()

    // the follow-up round queued behind it has already started, and stalls the same way; the one after reads
    stalled = false
    await vi.advanceTimersByTimeAsync(STALL_MS)
    await pollTick()
    expect(status()).toBe('')
    expect(row(second)?.textContent).toContain('After the outage')
    expect(badgeCount()).toBe(2)
  })

  it('ends a plain poll of /api/activity that never answers, the same way', async () => {
    db = freshDb()
    const first = insertItem(db, { ...AGENT, kind: 'question', title: 'Established' })
    let stalled = false
    await bootApp(db, {
      interceptFetch: async (input, init, next) =>
        (stalled && isGet(init) && route(input) === '/api/activity' ? new Promise<Response>(() => {}) : next()),
    })
    await showInbox()
    expectConsoleError(/TimeoutError/)
    stalled = true
    const second = insertItem(db, { ...AGENT, kind: 'question', title: 'After the outage' })

    await pollTick()
    await vi.advanceTimersByTimeAsync(STALL_MS - 1_000)
    expect(status()).toBe('')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(status()).toBe('disconnected')
    expect(row(first)?.textContent).toContain('Established')
    expect(row(second)).toBeNull()

    stalled = false
    await vi.advanceTimersByTimeAsync(STALL_MS)
    await pollTick()
    expect(status()).toBe('')
    expect(row(second)?.textContent).toContain('After the outage')
  })

  it('ends a snapshot body that delivers one chunk and then nothing, the same way', async () => {
    db = freshDb()
    upsertBoard(db, { ...AGENT, title: 'Plan', rows: [{ label: 'Step', status: 'tracked', note: 'the note' }] })
    const first = insertItem(db, { ...AGENT, kind: 'question', title: 'Established' })
    let stalled = false
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        // slow links, step 2: the plans list's body is the read of the changed plans by id
        if (!stalled || !isGet(init) || route(input) !== '/api/boards/plans') return next()
        const response = await next()
        if (response.status !== 200) return response
        const bytes = new Uint8Array(await response.arrayBuffer())
        // the headers arrive, then one piece of the body and never the rest
        const body = new ReadableStream<Uint8Array>({ start(out) { out.enqueue(bytes.slice(0, 10)) } })
        return new Response(body, { status: response.status, headers: response.headers })
      },
    })
    await showInbox()
    expectConsoleError(/Invalid snapshot JSON: \/api\/boards\/plans\?ids=/)
    stalled = true
    // a new plan, so the round reads it by id, a 200 with a body
    upsertBoard(db, { ...AGENT, title: 'Another plan', rows: [{ label: 'Step', status: 'tracked', note: 'the note' }] })
    const second = insertItem(db, { ...AGENT, kind: 'question', title: 'After the outage' })

    await pollTick()
    // the round waits for the stalled body, so the page still shows the old frame
    await vi.advanceTimersByTimeAsync(STALL_MS - 1_000)
    expect(row(second)).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    // the body's read failed at the limit (snapshots.js words it as an invalid body), and the round fails with it
    expect(status()).toBe('disconnected')
    expect(row(first)?.textContent).toContain('Established')
    expect(row(second)).toBeNull()

    // the follow-up round queued behind it stalls the same way; the one after reads
    stalled = false
    await vi.advanceTimersByTimeAsync(STALL_MS)
    await pollTick()
    expect(status()).toBe('')
    expect(row(second)?.textContent).toContain('After the outage')
  })
})

describe('the plans list over a slow link (slow links, step 2)', () => {
  it('reads only the plan that changed: its tags, then that plan by id, and never the whole list', async () => {
    db = freshDb()
    for (let n = 0; n < 3; n++) {
      upsertBoard(db, { ...AGENT, title: `Plan ${n}`, rows: [{ label: 'Step', status: 'tracked', note: `note ${n}` }] })
    }
    const reads: string[] = []
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (isGet(init)) reads.push(String(input))
        return next()
      },
    })
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    expect(document.getElementById('boards')?.textContent).toContain('note 1')

    const changed = getBoard(db, 'alpha', 'Plan 1')!
    upsertBoard(db, {
      ...AGENT, title: 'Plan 1', expectedVersion: changed.revision,
      rows: [{ label: 'Step', revision: changed.rows[0]!.revision, status: 'tracked', note: 'the changed note' }],
    })
    reads.length = 0
    await pollTick()
    const plansReads = reads.filter((url) => route(url).startsWith('/api/boards') && !route(url).startsWith('/api/boards/archived'))
    expect(plansReads).toEqual(['/api/boards/tags', `/api/boards/plans?ids=${changed.id}`])
    expect(reads.map(route)).not.toContain('/api/boards')
    expect(status()).toBe('')
    const plansText = document.getElementById('boards')?.textContent
    expect(plansText).toContain('the changed note')
    expect(plansText).not.toContain('note 1')
    expect(plansText).toContain('note 0')
    expect(plansText).toContain('note 2')
  })
})
