// public/stall.js (slow links, step 1): a poll read that stops arriving ends after STALL_MS, a
// slow body that keeps arriving never does, and an answer with no readable body passes untouched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STALL_MS, stallLimited } from '../public/stall.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const bytes = (text: string) => new TextEncoder().encode(text)

/** A body whose chunks arrive when the test says so. */
function drip(): { stream: ReadableStream<Uint8Array>; push(text: string): void; end(): void; cancelled: () => unknown } {
  let out!: ReadableStreamDefaultController<Uint8Array>
  let reason: unknown = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { out = controller },
    cancel(why) { reason = why ?? 'cancelled' },
  })
  return { stream, push: (text) => out.enqueue(bytes(text)), end: () => out.close(), cancelled: () => reason }
}

describe('stallLimited', () => {
  it('is 30 seconds', () => {
    expect(STALL_MS).toBe(30_000)
  })

  it('aborts a read whose headers have not arrived within 30 s', async () => {
    let signal!: AbortSignal
    const read = stallLimited((s) => { signal = s; return new Promise<Response>(() => {}) })
    const outcome = read.then(() => 'answered', (error: DOMException) => error.name)
    await vi.advanceTimersByTimeAsync(STALL_MS - 1)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe('TimeoutError')
    expect(signal.aborted).toBe(true)
  })

  it('passes a network error through as it is', async () => {
    const error = new TypeError('offline')
    await expect(stallLimited(() => Promise.reject(error))).rejects.toBe(error)
  })

  it('aborts a body that stops arriving for 30 s while it is read', async () => {
    const body = drip()
    let signal!: AbortSignal
    const response = await stallLimited(async (s) => { signal = s; return new Response(body.stream, { headers: { etag: '"a"' } }) })
    expect(response.headers.get('etag')).toBe('"a"')
    const text = response.text().then(() => 'read', (error: DOMException) => error.name)
    body.push('{"part":')
    await vi.advanceTimersByTimeAsync(STALL_MS - 1)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await text).toBe('TimeoutError')
    expect(signal.aborted).toBe(true)
    expect(body.cancelled()).not.toBeNull()
  })

  it('never cuts a slow body that keeps arriving, however long it takes', async () => {
    const body = drip()
    const response = await stallLimited(async () => new Response(body.stream))
    const text = response.text()
    for (let n = 0; n < 6; n++) {
      await vi.advanceTimersByTimeAsync(STALL_MS - 1_000)
      body.push(`chunk ${n};`)
    }
    await vi.advanceTimersByTimeAsync(STALL_MS - 1_000)
    body.end()
    expect(await text).toBe('chunk 0;chunk 1;chunk 2;chunk 3;chunk 4;chunk 5;')
  })

  it('does not count the time before the body is read', async () => {
    const body = drip()
    const response = await stallLimited(async () => new Response(body.stream))
    // the round waits for every other read's headers before it reads any body
    await vi.advanceTimersByTimeAsync(STALL_MS * 1.2)
    const json = response.json()
    // nothing may be pulled ahead of the read: the clock for the body starts here, not at the headers
    await vi.advanceTimersByTimeAsync(STALL_MS * 0.3)
    body.push('[1,2,3]')
    body.end()
    expect(await json).toEqual([1, 2, 3])
  })

  it('rejects, and lets the connection go, when the answer cannot be wrapped', async () => {
    const body = drip()
    let signal!: AbortSignal
    // a readable body with a status the Response constructor refuses
    const refused = { status: 600, statusText: '', headers: new Headers(), body: body.stream } as unknown as Response
    const read = stallLimited(async (s) => { signal = s; return refused })
    const outcome = read.then(() => 'answered', (error: Error) => error.name)
    await vi.advanceTimersByTimeAsync(0)
    expect(await outcome).toBe('RangeError')
    expect(signal.aborted).toBe(true)
    // the header timer is gone too: nothing left to settle the promise a second time
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes an answer with no readable body through untouched', async () => {
    const notModified = new Response(null, { status: 304, headers: { etag: '"a"' } })
    expect(await stallLimited(async () => notModified)).toBe(notModified)
    const empty = new Response(null, { status: 204 })
    expect(await stallLimited(async () => empty)).toBe(empty)
    const standIn = { status: 200, headers: new Headers(), body: { text: 'no reader' }, json: async () => ({}) } as unknown as Response
    expect(await stallLimited(async () => standIn)).toBe(standIn)
    // nothing left running
    expect(vi.getTimerCount()).toBe(0)
  })
})
