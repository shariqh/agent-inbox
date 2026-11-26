// @vitest-environment jsdom
// Slow links, step 1, the page half: the real public/app.js on fake timers, its reads bridged
// onto the real viewer app. One round runs at a time, so a body slower than several 3 s ticks is
// read once and its tag is stored for the next round (public/snapshots.js keeps only the newest
// request's tag), and a read that stops arriving ends the round the way a network error does.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertBoard } from '../../src/store.js'
import { STALL_MS } from '../../public/stall.js'
import { badgeCount, bootApp, expectConsoleError, freshDb, pollTick, row, settle, showInbox, useDomTest } from './harness.js'

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
  it('reads a slow plans list once, and the next round revalidates it with the stored tag', async () => {
    db = freshDb()
    for (let n = 0; n < 4; n++) {
      upsertBoard(db, { ...AGENT, title: `Plan ${n}`, rows: [{ label: 'Step', status: 'tracked', note: 'the note' }] })
    }
    const boards: Array<{ ifNoneMatch: string | null; etag: string | null; status: number }> = []
    let slow = true
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (route(input) !== '/api/boards' || !isGet(init)) return next()
        const sent = new Headers(init?.headers)
        const response = await next()
        boards.push({ ifNoneMatch: sent.get('If-None-Match'), etag: response.headers.get('etag'), status: response.status })
        if (!slow) return response
        slow = false
        // 5 pieces, one every 2.5 s: the body takes 12.5 s, four poll ticks, and never stalls
        return slowly(response, 5, 2_500)
      },
    })
    expect(boards).toHaveLength(1)
    expect(boards[0]!.ifNoneMatch).toBeNull()

    // four ticks while the body is still arriving: none starts a read
    for (let tick = 0; tick < 4; tick++) await pollTick()
    expect(boards, 'only one /api/boards request while the first was in flight').toHaveLength(1)

    // the body ends at 12.5 s; the next tick is not due until 15 s
    await vi.advanceTimersByTimeAsync(1_000)
    // the ticks shared one follow-up round, which sent the tag the slow body was stored under
    expect(boards).toHaveLength(2)
    expect(boards[0]!.etag).toMatch(/^"boards-/)
    expect(boards[1]!.ifNoneMatch).toBe(boards[0]!.etag)
    expect(boards[1]!.status).toBe(304)
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
})
