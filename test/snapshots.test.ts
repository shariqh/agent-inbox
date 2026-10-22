import { describe, expect, it, vi } from 'vitest'
import { activityHistoryUrl, createSnapshotReader } from '../public/snapshots.js'
import { buildIssueGraph } from '../src/issue-graph.js'
import { at, depsOf, keySets, row, snapshot } from './issue-fixtures.js'

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

  // Issue #184: the page carries a closed-history summary, and the complete
  // History list is a separate representation with its own validator.
  it('validates the closed-history summary and the separate History representation', async () => {
    const summary = { total: 3, loaded: 1, before: '2026-10-01T00:00:00.000Z', older: [{ project: 'alpha', agent: 'copilot', items: 2, outcomes: 1 }] }
    const done = { done: [{ id: 'old', title: 'Old', project: 'alpha', agent: 'copilot', kind: 'note', status: 'resolved' }] }
    const json = (value: unknown, etag: string) => new Response(JSON.stringify(value), { headers: { etag } })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ ...payload('A'), history: summary }, '"page"'))
      .mockResolvedValueOnce(json(done, '"history"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const read = createSnapshotReader(fetcher)
    const page = await (await read('/api/items')).json()
    const history = await (await read('/api/items/history')).json()
    expect(page).toEqual({ ...payload('A'), history: summary })
    expect(history).toEqual(done)
    expect(Object.isFrozen((history as typeof done).done[0])).toBe(true)
    expect(await (await read('/api/items/history')).json()).toBe(history)
    expect(fetcher.mock.calls[2]?.[0]).toBe('/api/items/history')
    expect(fetcher.mock.calls[2]?.[1]?.headers).toEqual({ 'If-None-Match': '"history"' })
    expect(await (await read('/api/items')).json()).toBe(page)
    expect(fetcher.mock.calls[3]?.[1]?.headers).toEqual({ 'If-None-Match': '"page"' })
  })

  it.each([
    ['/api/items', { ...payload('A'), history: { total: 1, loaded: 0, before: 7, older: [] } }],
    ['/api/items', { ...payload('A'), history: { total: 1, loaded: 0, before: null, older: [{ project: 'alpha', items: 1, outcomes: 0 }] } }],
    ['/api/items/history', { done: 'broken' }],
    ['/api/items/history', [{ id: 'bare-array' }]],
  ])('rejects a malformed %s closed-history payload', async (route, value) => {
    const read = createSnapshotReader(vi.fn().mockResolvedValue(new Response(JSON.stringify(value), { headers: { etag: '"bad"' } })))
    await expect((await read(route)).json()).rejects.toThrow('Invalid snapshot payload')
  })

  // #184 + #185: the page, the complete History list and activity history each
  // keep their own slot, even when every server tag is the same opaque string,
  // and the dock watcher's `?scope=attention` projection can never enter (and so
  // never share or evict) the page's slot.
  it('never lets the item, History or activity-history representations share a slot', async () => {
    const window = activityHistoryUrl(Date.parse('2026-07-20T10:00:00.000Z'))
    const bodies: Record<string, unknown> = {
      '/api/items': payload('page'),
      '/api/items/history': { done: [{ id: 'old', title: 'Old', project: 'alpha', agent: 'copilot', kind: 'note', status: 'resolved' }] },
      [window]: [{ session: 'span' }],
    }
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const sent = new Headers(init?.headers).get('if-none-match')
      return sent === '"same"'
        ? new Response(null, { status: 304, headers: { etag: '"same"' } })
        : new Response(JSON.stringify(bodies[url]), { headers: { etag: '"same"' } })
    })
    const read = createSnapshotReader(fetcher)
    const first = new Map<string, unknown>()
    for (const url of Object.keys(bodies)) first.set(url, await (await read(url)).json())
    await expect(read('/api/items?scope=attention')).rejects.toThrow('Unsupported snapshot route')
    await expect(read('/api/items/history?page=2')).rejects.toThrow('Unsupported snapshot route')
    expect(fetcher).toHaveBeenCalledTimes(3)
    for (const url of [...Object.keys(bodies)].reverse()) {
      const response = await read(url)
      expect(response.status, url).toBe(304)
      expect(await response.json(), url).toBe(first.get(url))
      expect(await response.json(), url).toEqual(bodies[url])
    }
    expect(fetcher.mock.calls.slice(3).map(([url, init]) => [url, new Headers(init?.headers).get('if-none-match')]))
      .toEqual([...Object.keys(bodies)].reverse().map((url) => [url, '"same"']))
  })
})

// Issue #185: the poll's history read names its window in the query string.
describe('activity history snapshots', () => {
  const HOUR = 60 * 60 * 1000
  const WINDOW = 30 * 24 * HOUR
  const since = (url: string): number => Number(new URL(url, 'http://viewer.test').searchParams.get('since_ms'))

  it('requests one stable window per hour that always covers the last 30 days', () => {
    const start = Date.parse('2026-07-20T10:00:00.000Z')
    const url = activityHistoryUrl(start)
    expect(url).toBe(`/api/activity/history?since_ms=${start - WINDOW}`)
    expect(activityHistoryUrl(start + HOUR - 1)).toBe(url)
    expect(since(activityHistoryUrl(start + HOUR))).toBe(start - WINDOW + HOUR)
    for (const now of [start + 1, start + 1_234_567, start + HOUR - 1, start + 7 * HOUR + 5]) {
      expect(since(activityHistoryUrl(now))).toBeLessThanOrEqual(now - WINDOW)
      expect(since(activityHistoryUrl(now))).toBeGreaterThan(now - WINDOW - HOUR)
    }
  })

  it('reuses a history representation only for the exact window that fetched it', async () => {
    const first = '/api/activity/history?since_ms=1000'
    const next = '/api/activity/history?since_ms=2000'
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('[{"session":"a"}]', { headers: { etag: '"first"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response('[{"session":"b"}]', { headers: { etag: '"next"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const read = createSnapshotReader(fetcher)
    const a = await (await read(first)).json()
    expect(await (await read(first)).json()).toBe(a)
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({ 'If-None-Match': '"first"' })
    const b = await (await read(next)).json()
    expect(b).toEqual([{ session: 'b' }])
    expect(fetcher.mock.calls[2]?.[1]?.headers).toBeUndefined()
    expect(await (await read(next)).json()).toBe(b)
    expect(fetcher.mock.calls[3]?.[1]?.headers).toEqual({ 'If-None-Match': '"next"' })
    // The newer window retired the older one; nothing can answer for it with a 304.
    await expect((await read(first)).json()).rejects.toThrow('without a representation')
    expect(fetcher.mock.calls[4]?.[1]?.headers).toBeUndefined()
  })

  it('retires a history validator once its server stops tagging', async () => {
    const url = activityHistoryUrl(Date.parse('2026-07-20T10:00:00.000Z'))
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('[{"session":"a"}]', { headers: { etag: '"a"' } }))
      .mockResolvedValueOnce(new Response('[{"session":"b"}]'))
      .mockResolvedValueOnce(new Response('[{"session":"c"}]'))
    const read = createSnapshotReader(fetcher)
    await (await read(url)).json()
    expect(await (await read(url)).json()).toEqual([{ session: 'b' }])
    expect(await (await read(url)).json()).toEqual([{ session: 'c' }])
    expect(fetcher.mock.calls[2]?.[1]?.headers).toBeUndefined()
  })

  it.each([
    () => new Response('unavailable', { status: 503, headers: { etag: '"bad"' } }),
    () => new Response('{"spans":[]}', { headers: { etag: '"bad"' } }),
    () => new Response('[null]', { headers: { etag: '"bad"' } }),
  ])('keeps the good history representation after a failed or malformed response', async (bad) => {
    const url = activityHistoryUrl(Date.parse('2026-07-20T10:00:00.000Z'))
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('[]', { headers: { etag: '"good"' } }))
      .mockResolvedValueOnce(bad())
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const read = createSnapshotReader(fetcher)
    const good = await (await read(url)).json()
    await expect((await read(url)).json()).rejects.toThrow()
    expect(await (await read(url)).json()).toBe(good)
    expect(Object.isFrozen(good)).toBe(true)
    expect(fetcher.mock.calls[2]?.[1]?.headers).toEqual({ 'If-None-Match': '"good"' })
  })
})

// Issue #103 PR3: the sub-issue graph is the poll's eighth read, a conditional
// snapshot with a validator of its own. A body the validator refuses is never
// cached; load() turns that refusal into "no graph", never a failed tick.
describe('the /api/issues snapshot', () => {
  const graph = {
    version: 1,
    nodes: [{ key: 'shariqh/agent-inbox#117', repo: 'shariqh/agent-inbox', number: 117, title: 'Parent', state: 'OPEN', state_reason: null, observed_at: '2026-10-19T22:30:00.000Z' }],
    edges: [{ kind: 'contains', from: 'shariqh/agent-inbox#117', to: 'shariqh/agent-inbox#120', position: 0, observed_at: '2026-10-19T22:30:00.000Z' }],
    roots: [{ key: 'shariqh/agent-inbox#120', refresh: true, fetched_at: '2026-10-19T22:30:00.000Z', checked_at: '2026-10-19T22:30:00.000Z', error: null, failure: null, children_omitted: 0 }],
    aliases: {},
    truncated: { roots: 0, ancestors: 0, children: 0, edges: 0 },
  }
  const json = (value: unknown, etag?: string) =>
    new Response(JSON.stringify(value), { headers: etag ? { etag } : {} })

  it('accepts a version 1 graph, freezes it and revalidates it in its own slot', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(graph, '"g"'))
      .mockResolvedValueOnce(json(payload('A'), '"g"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const read = createSnapshotReader(fetcher)
    const first = await (await read('/api/issues')).json()
    expect(first).toEqual(graph)
    expect(Object.isFrozen((first as typeof graph).roots[0])).toBe(true)
    await (await read('/api/items')).json() // the same opaque tag on another route shares nothing
    expect(fetcher.mock.calls[1]?.[1]?.headers).toBeUndefined()
    expect(await (await read('/api/issues')).json()).toBe(first)
    expect(fetcher.mock.calls[2]?.[1]?.headers).toEqual({ 'If-None-Match': '"g"' })
  })

  // Review round 1: each root says whether its own hierarchy could be read. The
  // field is additive within version 1, so a body without it is still valid.
  it.each([
    ['present and ok', 'ok'],
    ['present and unavailable', 'unavailable'],
    ['null, with no readable snapshot', null],
    ['absent', undefined],
  ])('accepts a root whose hierarchy status is %s', async (_label, hierarchy) => {
    const root = { ...graph.roots[0]!, ...(hierarchy === undefined ? {} : { hierarchy }) }
    const read = createSnapshotReader(vi.fn().mockResolvedValue(json({ ...graph, roots: [root] })))
    expect(await (await read('/api/issues')).json()).toEqual({ ...graph, roots: [root] })
  })

  it.each([
    ['another version', { ...graph, version: 2 }],
    ['a root with an unknown hierarchy status', { ...graph, roots: [{ ...graph.roots[0], hierarchy: 'partial' }] }],
    ['a root whose hierarchy status is not text', { ...graph, roots: [{ ...graph.roots[0], hierarchy: { status: 'ok' } }] }],
    ['a bare array', [graph]],
    ['nodes that are not an array', { ...graph, nodes: {} }],
    ['a node without a string key', { ...graph, nodes: [{ ...graph.nodes[0], key: 117 }] }],
    ['an edge without its ends', { ...graph, edges: [{ kind: 'contains', from: 'shariqh/agent-inbox#117' }] }],
    ['a root without a string key', { ...graph, roots: [{ refresh: true }] }],
    ['roots that are missing', { ...graph, roots: undefined }],
    ['aliases that are not a record', { ...graph, aliases: [] }],
  ])('refuses %s without caching its validator', async (_label, value) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(value, '"bad"'))
      .mockResolvedValueOnce(json(graph))
    const read = createSnapshotReader(fetcher)
    await expect((await read('/api/issues')).json()).rejects.toThrow('Invalid snapshot payload')
    await (await read('/api/issues')).json()
    expect(fetcher.mock.calls[1]?.[1]?.headers).toBeUndefined()
  })

  it('fails explicitly on a 404 from a viewer that predates the route, and takes no query', async () => {
    const read = createSnapshotReader(vi.fn().mockResolvedValue(new Response('<!doctype html>', { status: 404 })))
    await expect((await read('/api/issues')).json()).rejects.toThrow('HTTP 404')
    await expect(read('/api/issues?scope=attention')).rejects.toThrow('Unsupported snapshot route')
  })

  // Slice 2 PR B: GitHub dependencies stay inside version 1. Were the body
  // refused, load() would fall back to "no graph" and every breadcrumb, child
  // list and plan group would silently vanish; so the real builder's output is
  // read here, with every new field present.
  it('accepts the builder\'s body with blocks edges, node deps and each root\'s dependency fields', async () => {
    const K = (n: number) => `shariqh/agent-inbox#${n}`
    const section = depsOf([[K(119), K(121)], [K(121), K(119)], [K(120), K(121)]])
    const body = JSON.parse(JSON.stringify(buildIssueGraph([
      row(K(121), snapshot(K(121), { ancestors: [K(117)] }), at(10), { dependencies: section(K(121)) }),
      row(K(119), snapshot(K(119)), at(10), { dependencies: section(K(119)) }),
      row(K(122), snapshot(K(122)), at(10), { dependencies: { status: 'unavailable' } }),
      row(K(123), snapshot(K(123)), at(10)),
      row(K(124), null, null, { error: 'offline', checkedAt: at(10) }),
    ], keySets([K(121), K(119), K(122), K(123), K(124)]), { maxUnits: 6 }))) as {
      edges: Array<{ kind: string; cycle?: true }>
      nodes: Array<{ deps?: unknown }>
      roots: Array<{ dependencies: unknown; dependencies_omitted: number }>
      truncated: { dependencies: number }
    }
    expect(body.edges.map((e) => [e.kind, e.cycle ?? false])).toEqual([['contains', false], ['blocks', true], ['blocks', true]])
    expect(body.nodes.filter((n) => n.deps)).toHaveLength(2)
    expect(body.roots.map((r) => r.dependencies).sort()).toEqual([null, 'ok', 'ok', 'unavailable', 'unknown'].sort())
    expect(body.roots.some((r) => r.dependencies_omitted > 0)).toBe(true)
    expect(body.truncated.dependencies).toBe(1)
    const read = createSnapshotReader(vi.fn().mockResolvedValue(json(body, '"deps"')))
    expect(await (await read('/api/issues')).json()).toEqual(body)
  })
})

// Issue #288: the cached PR state is a conditional snapshot too. A body the
// validator refuses is never cached, and load() turns any failure into "no
// links", never a failed tick.
describe('the /api/links snapshot', () => {
  const links = [{
    repo: 'shariqh/agent-inbox', branch: 'feature', head_repo: 'shariqh/agent-inbox', provider: 'github',
    pr_number: 41, pr_url: 'https://github.com/shariqh/agent-inbox/pull/41', pr_state: 'OPEN', pr_draft: false,
    checked_at: '2026-10-22T12:00:00.000Z', fetched_at: '2026-10-22T12:00:00.000Z', error: null, revision: 1,
  }]
  const json = (value: unknown, etag?: string) =>
    new Response(JSON.stringify(value), { headers: etag ? { etag } : {} })

  it('accepts the cached links, freezes them and revalidates them in their own slot', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(links, '"l"'))
      .mockResolvedValueOnce(json([], '"l"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const read = createSnapshotReader(fetcher)
    const first = await (await read('/api/links')).json()
    expect(first).toEqual(links)
    expect(Object.isFrozen((first as typeof links)[0])).toBe(true)
    await (await read('/api/boards')).json() // the same opaque tag on another route shares nothing
    expect(fetcher.mock.calls[1]?.[1]?.headers).toBeUndefined()
    expect(await (await read('/api/links')).json()).toBe(first)
    expect(fetcher.mock.calls[2]?.[1]?.headers).toEqual({ 'If-None-Match': '"l"' })
  })

  it.each([
    ['a record', { links }],
    ['a missing entry', [null]],
    ['an entry without a repository', [{ ...links[0], repo: undefined }]],
    ['an entry whose branch is not text', [{ ...links[0], branch: 7 }]],
  ])('refuses %s without caching its validator', async (_label, value) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(value, '"bad"'))
      .mockResolvedValueOnce(json(links))
    const read = createSnapshotReader(fetcher)
    await expect((await read('/api/links')).json()).rejects.toThrow('Invalid snapshot payload')
    await (await read('/api/links')).json()
    expect(fetcher.mock.calls[1]?.[1]?.headers).toBeUndefined()
  })

  it('fails explicitly on a 404 from a viewer that predates the route, and takes no query', async () => {
    const read = createSnapshotReader(vi.fn().mockResolvedValue(new Response('<!doctype html>', { status: 404 })))
    await expect((await read('/api/links')).json()).rejects.toThrow('HTTP 404')
    await expect(read('/api/links?scope=attention')).rejects.toThrow('Unsupported snapshot route')
  })
})
