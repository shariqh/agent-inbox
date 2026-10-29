// @vitest-environment jsdom
// Issue #185: the poll revalidates activity history like the other snapshots.
// History also changes with TIME alone: an open span's capped end appears once it
// goes cold, with no database write. These tests therefore run against the real
// viewer's validators, never a conditional-response shim.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { CLAIM_COLD_MS, endActivity, readSnapshotState, upsertActivity } from '../../src/store.js'
import { T0, advanceClock, bootApp, freshDb, pollTick, settle, useDomTest } from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null; vi.unstubAllGlobals() })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
interface Read { url: string; sent: string | null; tag: string | null; status: number }

const isHistory = (input: RequestInfo | URL): boolean => String(input).split('?')[0] === '/api/activity/history'
const total = (): string | null | undefined => document.querySelector('.dashboard-activity-total strong')?.textContent
const bars = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.dash-ribbon-bar')].map((bar) => `${bar.style.left} ${bar.style.width} ${bar.title}`)

function span(d: Database.Database, session: string, startMs: number, endMs: number): void {
  vi.setSystemTime(startMs)
  upsertActivity(d, { ...AGENT, session, doing: `Work for ${session}` })
  vi.setSystemTime(endMs)
  endActivity(d, session)
}

async function chooseRange(ms: number): Promise<void> {
  const range = document.querySelector<HTMLSelectElement>('.dashboard-range')!
  range.value = String(ms)
  range.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
}

async function bootRecording(d: Database.Database, reads: Read[], failing = (): boolean => false): Promise<void> {
  await bootApp(d, {
    interceptFetch: async (input, init, next) => {
      if (!isHistory(input)) return next()
      const sent = new Headers(init?.headers).get('if-none-match')
      const response = failing() ? new Response('unavailable', { status: 503 }) : await next()
      reads.push({ url: String(input), sent, tag: response.headers.get('etag'), status: response.status })
      return response
    },
  })
}

describe('conditional activity history polling (issue #185)', () => {
  it('renders the dashboard from the reused history representation on a 304', async () => {
    db = freshDb()
    // Well inside one hourly bar, so a few seconds of polling cannot move it.
    span(db, 'reviewed', T0 + 40 * MINUTE, T0 + 65 * MINUTE)
    vi.setSystemTime(T0 + 150 * MINUTE)
    const reads: Read[] = []
    await bootRecording(db, reads)
    expect(reads).toEqual([expect.objectContaining({ sent: null, status: 200 })])
    expect(reads[0]!.tag).toMatch(/^"[^"]+"$/)
    expect(total()).toBe('25m')
    const painted = bars()
    expect(painted).toHaveLength(1)

    await pollTick()
    await pollTick()
    expect(reads.map((read) => read.status)).toEqual([200, 304, 304])
    expect(reads.every((read) => read.url === reads[0]!.url && read.tag === reads[0]!.tag)).toBe(true)
    expect(reads.slice(1).every((read) => read.sent === reads[0]!.tag)).toBe(true)
    expect(document.querySelector('.dashboard-history-error')).toBeNull()
    expect(total()).toBe('25m')
    expect(bars()).toEqual(painted)

    // Another range derives its own view from the same reused spans.
    await chooseRange(7 * DAY)
    expect(total()).toBe('25m')
    expect(bars()).toHaveLength(1)
    expect(bars()).not.toEqual(painted)
  })

  it('repaints history when only the clock carries an open span past its cold cutoff', async () => {
    db = freshDb()
    upsertActivity(db, { ...AGENT, session: 'live', doing: 'Working' })
    advanceClock(MINUTE)
    const reads: Read[] = []
    await bootRecording(db, reads)
    const first = reads[0]!
    expect(total()).toBe('1m')
    const before = readSnapshotState(db)

    // Still warm: unchanged bytes revalidate while the open span grows on screen.
    vi.setSystemTime(T0 + 20 * MINUTE)
    await pollTick()
    expect(reads.at(-1)).toMatchObject({ status: 304, sent: first.tag, url: first.url })
    expect(total()).toBe('20m')

    // Cold: nothing was written, yet the bytes changed, so the read is a 200.
    vi.setSystemTime(T0 + CLAIM_COLD_MS + 1000)
    await pollTick()
    const crossed = reads.at(-1)!
    expect(crossed).toMatchObject({ status: 200, sent: first.tag, url: first.url })
    expect(crossed.tag).not.toBe(first.tag)

    // The capped end holds instead of growing with the clock.
    vi.setSystemTime(T0 + CLAIM_COLD_MS + 10 * MINUTE)
    await pollTick()
    expect(reads.at(-1)).toMatchObject({ status: 304, sent: crossed.tag, url: first.url })
    expect(total()).toBe('30m')
    expect(readSnapshotState(db)).toEqual(before)
  })

  it('fetches a new hourly window in full, then revalidates that window', async () => {
    db = freshDb()
    span(db, 'reviewed', T0 + 40 * MINUTE, T0 + 65 * MINUTE)
    vi.setSystemTime(T0 + 150 * MINUTE)
    const reads: Read[] = []
    await bootRecording(db, reads)
    vi.setSystemTime(T0 + 180 * MINUTE)
    await pollTick()
    await pollTick()
    const [first, moved, revalidated] = reads
    expect(moved).toMatchObject({ status: 200, sent: null })
    expect(moved!.url).not.toBe(first!.url)
    expect(moved!.tag).not.toBe(first!.tag)
    expect(revalidated).toMatchObject({ status: 304, url: moved!.url, sent: moved!.tag })
    expect(total()).toBe('25m')
  })

  it('shows the history fallback on failure and revalidates the last good representation after', async () => {
    db = freshDb()
    span(db, 'reviewed', T0 + 40 * MINUTE, T0 + 65 * MINUTE)
    vi.setSystemTime(T0 + 150 * MINUTE)
    let failing = false
    const reads: Read[] = []
    await bootRecording(db, reads, () => failing)
    const good = reads[0]!.tag

    failing = true
    await pollTick()
    expect(reads.at(-1)).toMatchObject({ status: 503, sent: good })
    expect(document.querySelector('.dashboard-history-error')?.textContent).toBe('History unavailable')
    expect(bars()).toEqual([])
    expect(document.getElementById('status')?.textContent).toBe('')

    failing = false
    await pollTick()
    expect(reads.at(-1)).toMatchObject({ status: 304, sent: good, tag: good })
    expect(document.querySelector('.dashboard-history-error')).toBeNull()
    expect(total()).toBe('25m')
  })

  it('treats a 304 history response from a restarted viewer as a restart before reusing it', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { hash: '', reload })
    db = freshDb()
    span(db, 'reviewed', T0 + 40 * MINUTE, T0 + 65 * MINUTE)
    vi.setSystemTime(T0 + 150 * MINUTE)
    let historyBoot = 'original-viewer'
    const statuses: number[] = []
    await bootApp(db, {
      interceptFetch: async (input, _init, next) => {
        const response = await next()
        if (isHistory(input)) statuses.push(response.status)
        response.headers.set('x-inbox-boot', isHistory(input) ? historyBoot : 'original-viewer')
        return response
      },
    })
    await pollTick()
    expect(reload).not.toHaveBeenCalled()

    historyBoot = 'restarted-viewer'
    await pollTick()
    expect(statuses).toEqual([200, 304, 304])
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the dashboard to its own range when the hourly window also returns older spans', async () => {
    db = freshDb()
    // Ends inside the hour the window is floored to, before the 30-day range starts.
    span(db, 'older', T0 - 30 * DAY + 5 * MINUTE, T0 - 30 * DAY + 20 * MINUTE)
    span(db, 'recent', T0 - 60 * MINUTE, T0 - 50 * MINUTE)
    vi.setSystemTime(T0 + 30 * MINUTE)
    const returned: string[] = []
    await bootApp(db, {
      interceptFetch: async (input, _init, next) => {
        const response = await next()
        if (isHistory(input) && response.status === 200) {
          for (const { session } of await response.clone().json() as Array<{ session: string }>) returned.push(session)
        }
        return response
      },
    })
    expect(returned).toEqual(['older', 'recent'])
    await chooseRange(30 * DAY)
    expect(total()).toBe('10m')
    expect(bars()).toHaveLength(1)
  })
})
