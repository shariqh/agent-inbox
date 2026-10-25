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
  insertItem, recordActivityCall, resolveItem, snoozeItem, touchActivity, upsertActivity, upsertBoard,
} from '../../src/store.js'
import { STALE_MS } from '../../public/attention.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, buttonLabelled, click, expectConsoleError, freshDb, pollTick,
  repaint, row, rowTitles, sendButton, setSystemDark, settle, showInbox, T0, type, useDomTest,
} from './harness.js'
import type { BootOptions } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'agentInboxLinks')
})

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

  it('repaints when what Live shows changed, and not for the liveness heartbeat', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Live changes' })
    upsertActivity(d, { ...AGENT, session: 'worker', doing: 'Building the idle frame' })
    recordActivityCall(d, 'worker')
    await bootApp(d)
    await showInbox()
    await pollTick()
    const before = row(id)!
    // The five-minute heartbeat moves only `updated_at`, which nothing shows.
    advanceClock()
    touchActivity(d, 'worker')
    await pollTick()
    expect(row(id), 'a heartbeat repainted an unchanged frame').toBe(before)
    // A new claim changes only /api/activity, which is never a 304.
    upsertActivity(d, { ...AGENT, session: 'worker', doing: 'Reviewing the idle frame' })
    await pollTick()
    expect(row(id)).not.toBe(before)
    expect(document.getElementById('liveDrawer')?.textContent).toContain('Reviewing the idle frame')
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

// State that changes outside the poll's reads and outside any paint. Each guard
// in frameInputs()/pollMaySkipPaint is the only thing that brings it to screen
// before the 30 s clock; every case below fails without its guard.
describe('changes outside the poll still reach an idle window (#298)', () => {
  it('paints a theme change a focused Dashboard control held back, once focus leaves', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Colour me' })
    await bootApp(d)
    click(document.getElementById('gear'))
    click(document.querySelector('input[name="theme-preference"][value="system"]'))
    click(document.getElementById('gear'))
    await settle()
    const wash = () => row(id)?.style.getPropertyValue('--wash')
    const light = wash()
    expect(light).toBeTruthy()
    // A frame painted while a Dashboard control holds keyboard focus.
    document.querySelector<HTMLElement>('#dashboard [data-dashboard-focus-key="flow:human"]')!.focus()
    await repaint()
    await pollTick()
    // The OS switches theme: the Dashboard focus holds the editable frame (renderDirty).
    setSystemDark(true)
    expect(wash()).toBe(light)
    // The window loses focus; the next tick reads only 304s.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
    await pollTick()
    expect(wash()).toBeTruthy()
    expect(wash(), 'rows kept the old theme’s project colours').not.toBe(light)
  })

  it('takes back a staged dismiss whose send failed', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Noise' })
    const bridge = await bootApp(d)
    await showInbox()
    await pollTick()
    click(row(id)!.querySelector('.nrow-dismiss'))
    await settle()
    expect(buttonLabelled('Undo dismiss', row(id)!)).not.toBeNull()
    bridge.failPostsWith(500)
    expectConsoleError(/dismiss failed: HTTP 500/)
    await vi.advanceTimersByTimeAsync(5000) // the undo window ends and the send fails
    await pollTick()
    expect(document.getElementById('status')?.textContent).toBe('')
    expect(buttonLabelled('Undo dismiss', row(id)!), 'still showing a dismiss that never happened').toBeNull()
    expect(row(id)?.classList.contains('staged')).toBe(false)
  })

  it('shows build advice /api/version gives after the first frame', async () => {
    const d = open()
    upsertActivity(d, {
      project: 'beta', stream: 'main', agent: 'claude-code', session: 'stale', doing: 'Working in beta',
      server_version: '1.2.6', server_source: 'checkout',
    })
    recordActivityCall(d, 'stale')
    let answer!: () => void
    const held = new Promise<void>((resolve) => { answer = resolve })
    await bootApp(d, {
      interceptFetch: async (input, _init, next) => {
        if (String(input) !== '/api/version') return next()
        await held
        return Response.json({ current: '2.0.0', mode: 'dev', runtimeInstalled: null, updatable: false, hosts: {} })
      },
    })
    const chip = () => [...document.querySelectorAll<HTMLElement>('#liveStripSessions .live-session')]
      .find((el) => el.textContent?.startsWith('beta/'))
    await pollTick()
    expect(chip()).toBeDefined()
    expect(chip()!.title).not.toMatch(/older build/)
    answer()
    await settle()
    await pollTick()
    expect(chip()?.title).toMatch(/^older build \(v1\.2\.6\)/)
  })

  // main's answer to whether this page may open local files lands when it lands
  function heldFilePermission(): (permitted: boolean) => void {
    let answer!: (permitted: boolean) => void
    const permission = new Promise<boolean>((resolve) => { answer = resolve })
    Object.defineProperty(window, 'agentInboxLinks', {
      configurable: true,
      value: { open: vi.fn(async () => ({ ok: true, action: 'opened' })), filesAvailable: vi.fn(() => permission) },
    })
    return answer
  }
  async function openFileCard(): Promise<string> {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Read the spec', detail: 'Spec at /Users/s/docs/spec.md:12' })
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    await pollTick()
    return id
  }
  const fileChip = (id: string) => row(id)?.querySelector<HTMLElement>('.card-links [data-link-kind="file"]') ?? null

  it('offers Reveal once main says file links open here', async () => {
    const answer = heldFilePermission()
    const id = await openFileCard()
    expect(fileChip(id)).not.toBeNull()
    expect(row(id)!.querySelector('.card-links [data-link-action="reveal"]')).toBeNull()
    answer(true)
    await settle()
    await pollTick()
    expect(row(id)!.querySelector('.card-links [data-link-action="reveal"]')).not.toBeNull()
  })

  it('turns file links into Copy path once main says this page is not its viewer', async () => {
    const answer = heldFilePermission()
    const id = await openFileCard()
    expect(fileChip(id)!.title).not.toMatch(/^Copy path/)
    answer(false)
    await settle()
    await pollTick()
    expect(fileChip(id)!.title).toBe('Copy path: /Users/s/docs/spec.md')
  })

  it('says a restarted viewer waits on unsent responses, though every read is a 304', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { hash: '', reload })
    const d = open()
    const id = insertItem(d, {
      ...AGENT, kind: 'question', title: 'Failed option', options: [{ label: 'Ship now', recommended: true }, { label: 'Hold' }],
    })
    let boot = 'original-viewer'
    const bridge = await bootApp(d, {
      interceptFetch: async (_input, _init, next) => {
        const response = await next()
        response.headers.set('x-inbox-boot', boot)
        return response
      },
    })
    await showInbox()
    click(row(id))
    await settle()
    bridge.failPostsWith(503)
    expectConsoleError(/reply failed: HTTP 503/)
    click(row(id)!.querySelector('.opt-pill'))
    await settle()
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Ship now')
    await pollTick()
    await pollTick()
    const hint = () => document.getElementById('pauseHint')?.textContent ?? ''
    expect(hint()).toBe('')
    boot = 'restarted-viewer'
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    expect(hint()).toContain('Viewer updated')
  })

  it('does not keep a frame drawn for the lens draft recovery replaced', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Resolved under a draft' })
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    type(answerInput(id), 'An answer the agent never reads')
    click(document.querySelector('.tab[data-tab="notes"]'))
    await settle()
    resolveItem(d, id)
    await pollTick() // the draft holds the editable frame
    // A tab change paints; draft recovery inside that frame moves the lens to the Inbox.
    click(document.querySelector('.tab[data-tab="done"]'))
    await settle()
    expect(document.querySelector('.tab[data-tab="needsYou"]')?.getAttribute('aria-selected')).toBe('true')
    const before = document.querySelector('#needsYouList .stale-drafts-fold')
    expect(before?.textContent).toContain('An answer the agent never reads')
    await pollTick()
    expect(document.querySelector('#needsYouList .stale-drafts-fold'), 'the poll kept a frame drawn for History').not.toBe(before)
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

  it('repaints on the next tick when the clock moved back', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'When was this?' })
    await bootApp(d)
    await showInbox()
    advanceClock(5 * 60_000)
    await pollTick()
    const asked = () => row(id)?.querySelector('.nrow-asked')?.textContent ?? ''
    expect(asked()).toContain('5m')
    vi.setSystemTime(Date.now() - 4 * 60_000)
    await pollTick()
    expect(asked()).toContain('1m')
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
