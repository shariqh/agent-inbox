// public/plans-reader.js (slow links, step 2): the poll's plans list read as tags, then only the
// plans not held at their tag, through the page's real snapshot reader over a stand-in hub.
import { describe, expect, it } from 'vitest'
import { createPlansReader } from '../public/plans-reader.js'
import { createSnapshotReader } from '../public/snapshots.js'

type Plan = { id: string; title: string; project: string; agent: string; rows: Array<{ id: string; label: string; status: string }>; progress: { done: number; countable: number; fraction: number } }

const plan = (id: string, title = `Plan ${id}`): Plan => ({
  id, title, project: 'alpha', agent: 'copilot',
  rows: [{ id: `${id}-r`, label: 'Step', status: 'tracked' }], progress: { done: 0, countable: 1, fraction: 0 },
})

// a stand-in tag: any function of the bytes does for the reader
const tagOf = (value: unknown): string => `t${JSON.stringify(value).length}-${[...JSON.stringify(value)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`

/** A stand-in hub serving the three plans routes from `plans`, recording each URL it is asked for. */
function hub(initial: Plan[]) {
  const state = {
    plans: initial,
    boot: 'boot-1',
    plansBoot: null as string | null,
    tagsStatus: 200,
    failPlans: null as ((url: string) => boolean) | null,
    leaveOut: new Set<string>(),
    asked: [] as string[],
  }
  const respond = (body: unknown, extra: Record<string, string> = {}, status = 200) =>
    new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { 'x-inbox-boot': state.boot, ...extra } })
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    state.asked.push(url)
    const [path, query] = url.split('?') as [string, string | undefined]
    if (path === '/api/boards/tags') {
      if (state.tagsStatus !== 200) return new Response('<!doctype html>', { status: state.tagsStatus })
      const body = { plans: state.plans.map((p) => ({ id: p.id, tag: tagOf(p) })) }
      const etag = `"tags-${tagOf(body)}"`
      const sent = new Headers(init?.headers).get('If-None-Match')
      return sent === etag ? respond(null, { etag }, 304) : respond(body, { etag })
    }
    if (path === '/api/boards/plans') {
      if (state.failPlans?.(url)) throw new TypeError('plans offline')
      const ids = new Set(new URLSearchParams(query).get('ids')!.split(','))
      const body = { plans: state.plans.filter((p) => ids.has(p.id) && !state.leaveOut.has(p.id)).map((p) => ({ tag: tagOf(p), plan: p })) }
      return respond(body, state.plansBoot ? { 'x-inbox-boot': state.plansBoot } : {})
    }
    if (path === '/api/boards') return respond(state.plans, { etag: `"boards-${tagOf(state.plans)}"` })
    return new Response('nope', { status: 404 })
  }
  return { state, read: createPlansReader(createSnapshotReader(fetcher)) }
}

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, k) => `p${from + k}`)
const plansAsked = (asked: string[]) => asked.filter((url) => url.startsWith('/api/boards/plans'))
  .map((url) => new URLSearchParams(url.split('?')[1]).get('ids'))

async function readAll(read: () => Promise<{ status: number; headers: Headers; json(): Promise<unknown> }>) {
  const response = await read()
  return { response, plans: await response.json() as Plan[] }
}

describe('createPlansReader', () => {
  it('reads every plan on the first read, ten ids a request, in order, and assembles the list in the tags\' order', async () => {
    const { state, read } = hub(ids(23).map((id) => plan(id)))
    const { response, plans } = await readAll(read)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-inbox-boot')).toBe('boot-1')
    expect(state.asked[0]).toBe('/api/boards/tags')
    expect(plansAsked(state.asked)).toEqual([ids(10).join(','), ids(10, 10).join(','), ids(3, 20).join(',')])
    expect(state.asked).not.toContain('/api/boards')
    expect(plans).toEqual(state.plans)
    expect(Object.isFrozen(plans)).toBe(true)
    expect(Object.isFrozen(plans[0])).toBe(true)
  })

  it('an unchanged round (304) returns the identical array and asks for no plan', async () => {
    const { state, read } = hub(ids(3).map((id) => plan(id)))
    const first = await readAll(read)
    state.asked.length = 0
    const second = await readAll(read)
    expect(second.response.status).toBe(304)
    expect(state.asked).toEqual(['/api/boards/tags'])
    expect(second.plans).toBe(first.plans)
  })

  it('one changed tag asks for exactly that id and keeps every other plan\'s identity', async () => {
    const { state, read } = hub(ids(12).map((id) => plan(id)))
    const first = await readAll(read)
    state.plans = state.plans.map((p) => (p.id === 'p7' ? plan('p7', 'Renamed') : p))
    state.asked.length = 0
    const second = await readAll(read)
    expect(plansAsked(state.asked)).toEqual(['p7'])
    expect(second.plans).not.toBe(first.plans)
    expect(second.plans.map((p) => p.title)).toEqual(state.plans.map((p) => p.title))
    second.plans.forEach((p, n) => {
      if (p.id === 'p7') expect(p).not.toBe(first.plans[n])
      else expect(p).toBe(first.plans[n])
    })
  })

  it('drops a plan the tags no longer name, and asks for nothing', async () => {
    const { state, read } = hub(ids(3).map((id) => plan(id)))
    const first = await readAll(read)
    state.plans = state.plans.filter((p) => p.id !== 'p1')
    state.asked.length = 0
    const second = await readAll(read)
    expect(plansAsked(state.asked)).toEqual([])
    expect(second.plans.map((p) => p.id)).toEqual(['p0', 'p2'])
    expect(second.plans[0]).toBe(first.plans[0])
    expect(second.plans[1]).toBe(first.plans[2])
  })

  it('fetches a new plan and places it in the tags\' order', async () => {
    const { state, read } = hub(ids(3).map((id) => plan(id)))
    const first = await readAll(read)
    state.plans = [plan('new'), ...state.plans]
    state.asked.length = 0
    const second = await readAll(read)
    expect(plansAsked(state.asked)).toEqual(['new'])
    expect(second.plans.map((p) => p.id)).toEqual(['new', 'p0', 'p1', 'p2'])
    expect(second.plans.slice(1)).toEqual(first.plans)
    second.plans.slice(1).forEach((p, n) => expect(p).toBe(first.plans[n]))
  })

  it('a failed second request fails the read; the next read asks only for the ids still missing', async () => {
    const { state, read } = hub(ids(25).map((id) => plan(id)))
    state.failPlans = (url) => url.includes('p10')
    const failed = await read()
    await expect(failed.json()).rejects.toThrow('plans offline')
    expect(plansAsked(state.asked)).toEqual([ids(10).join(','), ids(10, 10).join(',')])

    state.failPlans = null
    state.asked.length = 0
    const { plans } = await readAll(read)
    // the tags answered 304: the same list, but it was never assembled, so the missing plans are read
    expect(state.asked[0]).toBe('/api/boards/tags')
    expect(plansAsked(state.asked)).toEqual([ids(10, 10).join(','), ids(5, 20).join(',')])
    expect(plans).toEqual(state.plans)
  })

  it('fails the read when a plans answer names a different hub instance than the tags', async () => {
    const { state, read } = hub(ids(2).map((id) => plan(id)))
    state.plansBoot = 'boot-2'
    const response = await read()
    expect(response.headers.get('x-inbox-boot')).toBe('boot-1')
    await expect(response.json()).rejects.toThrow(/restarted/)
  })

  it('falls back to /api/boards when the tags route answers 404, and returns to tags when it is back', async () => {
    const { state, read } = hub(ids(2).map((id) => plan(id)))
    state.tagsStatus = 404
    const fallback = await readAll(read)
    expect(state.asked).toEqual(['/api/boards/tags', '/api/boards'])
    expect(fallback.response.headers.get('etag')).toMatch(/^"boards-/)
    expect(fallback.plans).toEqual(state.plans)

    state.tagsStatus = 200
    state.asked.length = 0
    const back = await readAll(read)
    expect(state.asked).toEqual(['/api/boards/tags', '/api/boards/plans?ids=p0,p1'])
    expect(back.plans).toEqual(state.plans)
  })

  it('leaves out a plan the tags name but the plans answer does not; the next round asks for it again, and a round without it asks for nothing', async () => {
    const { state, read } = hub(ids(3).map((id) => plan(id)))
    state.leaveOut.add('p1')
    const first = await readAll(read)
    expect(plansAsked(state.asked)).toEqual(['p0,p1,p2'])
    expect(first.plans.map((p) => p.id)).toEqual(['p0', 'p2'])

    state.asked.length = 0
    const second = await readAll(read)
    expect(plansAsked(state.asked)).toEqual(['p1'])
    expect(second.plans.map((p) => p.id)).toEqual(['p0', 'p2'])

    state.plans = state.plans.filter((p) => p.id !== 'p1')
    state.asked.length = 0
    const third = await readAll(read)
    expect(plansAsked(state.asked)).toEqual([])
    expect(third.plans.map((p) => p.id)).toEqual(['p0', 'p2'])
  })

  it('does not assemble the old copy of a plan held at an older tag when the answer for its new tag leaves it out', async () => {
    const { state, read } = hub(ids(3).map((id) => plan(id)))
    const first = await readAll(read)
    expect(first.plans.map((p) => p.id)).toEqual(['p0', 'p1', 'p2'])
    state.plans = state.plans.map((p) => (p.id === 'p1' ? plan('p1', 'Renamed') : p))
    state.leaveOut.add('p1')
    state.asked.length = 0
    const second = await readAll(read)
    expect(plansAsked(state.asked)).toEqual(['p1'])
    expect(second.plans.map((p) => p.id)).toEqual(['p0', 'p2'])
  })
})
