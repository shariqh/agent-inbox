import { describe, expect, it, vi } from 'vitest'
import { createSnapshotReader } from '../public/snapshots.js'

function payload(title = 'A') {
  return {
    needsYou: [{
      project: 'alpha',
      items: [{ id: 'item', project: 'alpha', agent: 'copilot', title, kind: 'question', status: 'open' }],
    }],
    notes: [],
    done: [],
  }
}

function response(title: string, etag?: string) {
  return new Response(JSON.stringify(payload(title)), {
    headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('per-window conditional snapshots', () => {
  it('exposes current headers before body use and never parses a 304 as JSON', async () => {
    const notModified = new Response(null, {
      status: 304, headers: { etag: '"a"', 'x-inbox-boot': 'new-process' },
    })
    const json = vi.spyOn(notModified, 'json')
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response('A', '"a"'))
      .mockResolvedValueOnce(notModified)
    const read = createSnapshotReader(fetcher)
    const first = await (await read('/api/items')).json()
    const second = await read('/api/items')
    expect(second.headers.get('x-inbox-boot')).toBe('new-process')
    expect(json).not.toHaveBeenCalled()
    expect(await second.json()).toBe(first)
    expect(json).not.toHaveBeenCalled()
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      cache: 'no-store', headers: { 'If-None-Match': '"a"' },
    })
  })

  it('pins an overlapping 304 to its requested representation without reverting the newer cache', async () => {
    const slow = deferred<Response>()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response('A', '"a"'))
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(response('B', '"b"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const read = createSnapshotReader(fetcher)
    const a = await (await read('/api/items')).json()
    const pending = read('/api/items')
    const b = await (await read('/api/items')).json()
    slow.resolve(new Response(null, { status: 304 }))
    expect(await (await pending).json()).toBe(a)
    expect(await (await read('/api/items')).json()).toBe(b)
    expect(fetcher.mock.calls[3]?.[1]?.headers).toEqual({ 'If-None-Match': '"b"' })
  })

  it('does not let a late 200 overwrite a newer response, including delayed body parsing', async () => {
    const body = deferred<unknown>()
    const oldResponse = response('ignored', '"old"')
    vi.spyOn(oldResponse, 'json').mockReturnValue(body.promise)
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response('A', '"a"'))
      .mockResolvedValueOnce(oldResponse)
      .mockResolvedValueOnce(response('C', '"c"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const read = createSnapshotReader(fetcher)
    await (await read('/api/items')).json()
    const oldBody = (await read('/api/items')).json()
    const c = await (await read('/api/items')).json()
    body.resolve(payload('Old response'))
    expect(await oldBody).toEqual(payload('Old response'))
    expect(await (await read('/api/items')).json()).toBe(c)
    expect(fetcher.mock.calls[3]?.[1]?.headers).toEqual({ 'If-None-Match': '"c"' })
  })

  it.each([
    () => new Response('failed', { status: 503, headers: { etag: '"bad"' } }),
    () => new Response('invalid json', { headers: { etag: '"bad"' } }),
    () => new Response(JSON.stringify({ needsYou: [], notes: [], done: 'invalid' }), { headers: { etag: '"bad"' } }),
  ])('does not replace good data or its validator after a failed/malformed response', async (bad) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response('A', '"a"'))
      .mockResolvedValueOnce(bad())
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const read = createSnapshotReader(fetcher)
    const a = await (await read('/api/items')).json()
    await expect((await read('/api/items')).json()).rejects.toThrow()
    expect(await (await read('/api/items')).json()).toBe(a)
    expect(fetcher.mock.calls[2]?.[1]?.headers).toEqual({ 'If-None-Match': '"a"' })
  })

  it('makes authoritative nested data immutable rather than caching optimistic edits', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response('A', '"a"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const read = createSnapshotReader(fetcher)
    const value = await (await read('/api/items')).json() as ReturnType<typeof payload>
    expect(Object.isFrozen(value.needsYou[0]!.items[0])).toBe(true)
    expect(() => { value.needsYou[0]!.items[0]!.title = 'Optimistic local change' }).toThrow()
    expect(() => { value.needsYou.push({ project: 'local', items: [] }) }).toThrow()
    expect(await (await read('/api/items')).json()).toEqual(payload('A'))
  })

  it('falls back to full requests when tags are absent, and retires an older validator', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response('A', '"a"'))
      .mockResolvedValueOnce(response('B'))
      .mockResolvedValueOnce(response('C'))
    const read = createSnapshotReader(fetcher)
    await (await read('/api/items')).json()
    await (await read('/api/items')).json()
    expect(await (await read('/api/items')).json()).toEqual(payload('C'))
    expect(fetcher.mock.calls[2]?.[1]?.headers).toBeUndefined()
  })

  it('rejects unsolicited 304s and does not conditionally cache other routes', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 304 }))
    const read = createSnapshotReader(fetcher)
    await expect((await read('/api/items')).json()).rejects.toThrow('without a representation')
    await expect(read('/api/activity')).rejects.toThrow('Unsupported snapshot route')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps validators scoped to their resource even when opaque tags are identical', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response('A', '"same"'))
      .mockResolvedValueOnce(new Response('[]', { headers: { etag: '"same"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const read = createSnapshotReader(fetcher)
    const items = await (await read('/api/items')).json()
    const boards = await (await read('/api/boards')).json()
    expect(fetcher.mock.calls[1]?.[1]?.headers).toBeUndefined()
    expect(await (await read('/api/items')).json()).toBe(items)
    expect(await (await read('/api/boards')).json()).toBe(boards)
  })

  it('rejects malformed nested board shape without caching its validator', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('[]', { headers: { etag: '"good"' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: 'b', title: 'Broken', project: 'alpha', agent: 'copilot', rows: null,
        progress: { done: 0, countable: 0, fraction: 0 },
      }]), { headers: { etag: '"bad"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const read = createSnapshotReader(fetcher)
    await (await read('/api/boards/archived')).json()
    await expect((await read('/api/boards/archived')).json()).rejects.toThrow('Invalid snapshot payload')
    expect(await (await read('/api/boards/archived')).json()).toEqual([])
    expect(fetcher.mock.calls[2]?.[1]?.headers).toEqual({ 'If-None-Match': '"good"' })
  })
})
