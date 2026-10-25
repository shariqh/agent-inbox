// @vitest-environment jsdom
// test/dom/idle-frame.test.ts
//
// Issue #298: a poll tick that changed nothing leaves the frame on screen alone.
// Node identity is the observable: render() rebuilds every queue row, so a row
// that is still THE node after a tick was not repainted, and one that is not was.
// Fake timers advance Date with each tick, so a loop of ticks is real elapsed
// time for every clock-derived label.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  insertItem, recordActivityCall, snoozeItem, touchActivity, upsertActivity, upsertBoard,
} from '../../src/store.js'
import { STALE_MS } from '../../public/attention.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, click, freshDb, pollTick, row, rowTitles, sendButton, settle,
  showInbox, T0, type, useDomTest,
} from './harness.js'
import type { BootOptions } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const POLL_MS = 3000
// The issue's slow clock is 30–60 s; this one is 30 s, so a clock-derived
// change shows by the first tick after it is due. A literal, not the module's
// constant, so a slower clock fails here instead of moving the bar.
const CLOCK_LAG_MS = 30_000 + POLL_MS

function open(): Database.Database {
  db = freshDb()
  return db
}

// Records each snapshot read's status, so "idle" is proved, not assumed.
function statusLog(statuses: Array<{ path: string; status: number }>): NonNullable<BootOptions['interceptFetch']> {
  return async (input, _init, next) => {
    const response = await next()
    statuses.push({ path: String(input).split('?')[0]!, status: response.status })
    return response
  }
}

// Ticks until `done()` holds, and returns the time it first did.
async function tickUntil(done: () => boolean, limitMs: number): Promise<number> {
  const until = Date.now() + limitMs
  while (Date.now() <= until) {
    await pollTick()
    if (done()) return Date.now()
  }
  throw new Error(`not within ${limitMs} ms`)
}

const strip = (): string => document.getElementById('liveStripLabel')?.textContent ?? ''

describe('an idle tick (#298)', () => {
  it('keeps the frame when every read reused its representation', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Nothing changes' })
    const statuses: Array<{ path: string; status: number }> = []
    await bootApp(d, { interceptFetch: statusLog(statuses) })
    await showInbox()
    const before = row(id)!
    for (let i = 0; i < 3; i++) {
      statuses.length = 0
      await pollTick()
      expect(statuses.filter((read) => read.path === '/api/items').map((read) => read.status)).toEqual([304])
      expect(row(id), `tick ${i + 1} rebuilt an unchanged frame`).toBe(before)
    }
    expect(badgeCount()).toBe(1)
  })

  // Each surface's own rebuilt node: these are replaced by every painted frame.
  for (const [where, enter, node] of [
    ['the Dashboard', async () => {}, () => document.querySelector('#dashboard .dashboard-live-list > *')],
    ['an open inspector', async (id: string) => {
      await showInbox()
      click(row(id))
      await settle()
    }, (id: string) => row(id)?.querySelector('.nrow-card') ?? null],
    ['Plans', async () => {
      click(document.querySelector('.tab[data-tab="boards"]'))
      await settle()
    }, () => document.querySelector('#boards .board')],
  ] as const) {
    it(`keeps ${where} idle too`, async () => {
      const d = open()
      const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Read me slowly' })
      upsertBoard(d, { ...AGENT, title: 'Plan', rows: [{ label: 'Step', status: 'tracked' }] })
      await bootApp(d)
      await enter(id)
      await pollTick() // the frame the last input asked for
      const before = node(id)
      expect(before).not.toBeNull()
      for (let i = 0; i < 3; i++) {
        await pollTick()
        expect(node(id), `tick ${i + 1} rebuilt an unchanged frame`).toBe(before)
      }
    })
  }

  it('repaints when a snapshot read changed', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'First' })
    await bootApp(d)
    await showInbox()
    const before = row(id)!
    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'Second' })
    await pollTick()
    expect(rowTitles()).toContain('Second')
    expect(row(id)).not.toBe(before)
    expect(badgeCount()).toBe(2)
  })

  it('repaints when a fresh read changed its bytes', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Live changes' })
    upsertActivity(d, { ...AGENT, session: 'worker', doing: 'Building the idle frame' })
    recordActivityCall(d, 'worker')
    await bootApp(d)
    await showInbox()
    await pollTick()
    const before = row(id)!
    // The liveness heartbeat changes only /api/activity, which is never a 304.
    advanceClock()
    touchActivity(d, 'worker')
    await pollTick()
    expect(row(id)).not.toBe(before)
    expect(strip()).toBe('1 reporting work')
  })

  it('paints a press-deferred frame on the next tick, which reads only 304s', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Held' })
    await bootApp(d)
    await showInbox()
    insertItem(d, { ...AGENT, kind: 'question', title: 'Arrived under a press' })
    await vi.advanceTimersByTimeAsync(POLL_MS - ((Date.now() - T0) % POLL_MS) - 100)
    const pressed = row(id)!
    pressed.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(200)
    expect(row(id), 'the press guard held the frame').toBe(pressed)
    expect(rowTitles()).not.toContain('Arrived under a press')
    // A release paints nothing by itself (#38); the next tick reads only 304s.
    window.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }))
    await pollTick()
    expect(rowTitles()).toContain('Arrived under a press')
  })

  it('repaints after human input, as the next tick always did', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Input' })
    await bootApp(d)
    await showInbox()
    await pollTick()
    const before = row(id)!
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    await pollTick()
    expect(row(id)).not.toBe(before)
    const after = row(id)!
    await pollTick()
    expect(row(id), 'one input buys one frame').toBe(after)
  })

  it('paints a human write at once, without waiting for a tick', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Answer me' })
    await bootApp(d)
    await showInbox()
    await pollTick()
    click(row(id))
    await settle()
    type(answerInput(id), 'Ship it')
    click(sendButton(id))
    await settle()
    expect(badgeCount()).toBe(0)
    expect(answerInput(id)?.value ?? '').toBe('')
  })
})

describe('clock-derived content still moves on an idle window (#298)', () => {
  // The activity-history window moves on the hour (#185), which is a changed
  // read. Start each case at twenty past, so no window below crosses an hour
  // and only the slow clock can repaint.
  beforeEach(() => { advanceClock(20 * 60_000) })

  it('ages a relative time within the slow clock', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'How long ago?' })
    const createdAt = Date.now()
    await bootApp(d)
    await showInbox()
    const asked = () => row(id)?.querySelector('.nrow-asked')?.textContent ?? ''
    const first = asked()
    const unchangedFrame = row(id)!
    await pollTick()
    expect(row(id), 'an idle tick before the clock is due keeps the frame').toBe(unchangedFrame)
    const changedAt = await tickUntil(() => asked() !== first, 60_000 + CLOCK_LAG_MS)
    expect(changedAt - (createdAt + 60_000)).toBeLessThanOrEqual(CLOCK_LAG_MS)
  })

  it('moves an ask to the stale fold within the slow clock', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Nobody is listening' })
    const createdAt = Date.now()
    await bootApp(d)
    await showInbox()
    advanceClock(STALE_MS - 20_000)
    await pollTick()
    expect(badgeCount()).toBe(1)
    const staleAt = await tickUntil(() => badgeCount() === 0, 20_000 + CLOCK_LAG_MS)
    expect(staleAt - (createdAt + STALE_MS)).toBeLessThanOrEqual(CLOCK_LAG_MS)
    expect(row(id)?.closest('details')).not.toBeNull()
  })

  it('brings a snoozed ask back within the slow clock', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Back soon' })
    const wakeAt = Date.now() + 10 * 60_000
    snoozeItem(d, id, new Date(wakeAt).toISOString())
    await bootApp(d)
    await showInbox()
    expect(badgeCount()).toBe(0)
    advanceClock(wakeAt - Date.now() - 20_000)
    await pollTick()
    expect(badgeCount()).toBe(0)
    const backAt = await tickUntil(() => badgeCount() === 1, 20_000 + CLOCK_LAG_MS)
    expect(backAt - wakeAt).toBeLessThanOrEqual(CLOCK_LAG_MS)
  })

  it('lets a Live claim go cold within the slow clock', async () => {
    const d = open()
    upsertActivity(d, { ...AGENT, session: 'worker', doing: 'Long build' })
    recordActivityCall(d, 'worker')
    const calledAt = Date.now()
    await bootApp(d)
    expect(strip()).toBe('1 reporting work')
    // /api/activity derives the decay on every read (#45), so this one reaches
    // the frame as a changed read rather than through the slow clock.
    advanceClock(30 * 60_000 - 20_000)
    touchActivity(d, 'worker') // the liveness heartbeat: not work
    await pollTick()
    expect(strip()).toBe('1 reporting work')
    const coldAt = await tickUntil(() => strip() !== '1 reporting work', 20_000 + CLOCK_LAG_MS)
    expect(coldAt - (calledAt + 30 * 60_000)).toBeLessThanOrEqual(CLOCK_LAG_MS)
    expect(strip()).toContain('no task reported')
  })
})
