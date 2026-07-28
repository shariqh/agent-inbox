// @vitest-environment jsdom
// test/dom/press-guard.test.ts
//
// Issue #38 · D2 — the ~4% eaten click. Real Chrome, CDP:
//
//   {"panelStillOpen":true,"sameInputNode":false,"sameSendNode":false,
//    "oldInputAttached":false,"oldSendAttached":false,"pauseHint":""}
//   === click straddling a poll render ===  click events seen: []
//
// The 3s rebuild destroys and recreates the node the human is pressing on, so
// Chrome has no common ancestor for `pointerdown` and `pointerup` and dispatches
// NO CLICK AT ALL. At human hold times that cost 1 click in 24 (≈ hold/3000ms), on
// EVERY surface — rail pills, tabs, Answer, Send, ★, the pager — not only the one
// that happened to get instrumented. `#pauseHint` was empty throughout: the viewer
// did not even claim to be pausing.
//
// THE HARNESS BLIND SPOT, and why these tests assert node identity instead of
// clicks: jsdom (29.1.1) implements PointerEvent, but it does NOT synthesize a
// `click` from pointerdown+pointerup the way a browser does — verified on this
// tree. So "the click was eaten" is unobservable here. Node identity across the
// press is exactly what CDP measured, and it is necessary and sufficient: if the
// pressed node is still the same attached node at pointerup, Chrome has its common
// ancestor and dispatches the click. Assert that, and say so out loud rather than
// writing a click assertion that would pass for the wrong reason.
//
// The fix deliberately is NOT "add openRows to suspendState()": the eaten click in
// the transcript is the one that OPENS the panel, so at pointerdown nothing is
// expanded and a gate keyed on expansion cannot defer that rebuild at all. It is
// also unbounded, un-prunable (openRows has no reconciliation — the C1 lesson) and
// would freeze the badge exactly where the human is acting. The press guard is
// bounded by a physical button-up and hard-bounded by PRESS_GRACE_MS, and it
// cannot strand because it is a timestamp comparison, not a flag.
import { describe, it, expect, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listBoards, upsertBoard } from '../../src/store.js'
import {
  advanceClock, badgeCount, bootApp, freshDb, pollTick, rowTitles, settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

const POLL_MS = 3000
/** bootApp() ends with settle(), which advances the fake clock by this much. */
const BOOT_SETTLE_MS = 20

/**
 * Park the fake clock `lead` ms before the next poll tick.
 *
 * The interval is registered when app.js is imported, so from a freshly-booted
 * harness the next tick is POLL_MS - BOOT_SETTLE_MS away. Call this ONCE per test,
 * straight after bootApp(). `crossTick()` then steps over the tick.
 *
 * The pair is self-checking: the first test below presses NOTHING and asserts the
 * node IS replaced, so if this arithmetic ever stopped straddling a real render,
 * that test fails instead of the guard tests passing vacuously.
 */
async function toJustBeforeTick(lead = 100): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL_MS - BOOT_SETTLE_MS - lead)
}
async function crossTick(lead = 100): Promise<void> {
  await vi.advanceTimersByTimeAsync(lead + 50)
}

function pointer(el: Element | null, type: 'pointerdown' | 'pointerup' | 'pointercancel'): void {
  if (!el) throw new Error(`pointer(): nothing to ${type} on`)
  el.dispatchEvent(new window.PointerEvent(type, { bubbles: true }))
}

/** A board with one blocked row — its Answer button is the CDP transcript's target. */
async function boardWithAnswerButton(): Promise<Database.Database> {
  const d = freshDb()
  db = d
  upsertBoard(d, { ...AGENT, title: 'rollout', rows: [{ label: 'ship', status: 'blocked', note: 'which region?' }] })
  await bootApp(d)
  document.querySelector<HTMLElement>('.tab[data-tab="boards"]')!.click()
  await settle()
  return d
}

const answerBtn = (): HTMLElement | null => document.querySelector('#boards .answer-btn')
const pauseHint = (): string => document.getElementById('pauseHint')?.textContent ?? ''

describe('#38 · D2 — the 3s rebuild must not land inside a press', () => {
  // The control. It proves the clock arithmetic really does straddle a poll
  // render, so the guard tests below cannot pass by simply never ticking.
  it('CONTROL: with no button down, the poll rebuilds the button — that is the mechanism', async () => {
    await boardWithAnswerButton()
    const before = answerBtn()
    expect(before, 'no .answer-btn rendered').not.toBeNull()

    await toJustBeforeTick()
    await crossTick()

    expect(document.contains(before!), 'the poll detaches the node the human is aiming at').toBe(false)
    expect(answerBtn()).not.toBe(before)
  })

  it('a held press keeps its target attached and identical across the tick', async () => {
    await boardWithAnswerButton()
    const pressed = answerBtn()!

    await toJustBeforeTick()
    pointer(pressed, 'pointerdown')
    await crossTick()

    expect(document.contains(pressed), 'the press target was destroyed mid-press — Chrome fires no click').toBe(true)
    expect(answerBtn(), 'and it is still THE node, not a fresh one in its place').toBe(pressed)
  })

  it('a bare press is not a pause, and #pauseHint must not claim otherwise', async () => {
    // Non-discriminating on its own — the hint is '' today too, which is precisely
    // the lie the CDP run caught (destroying an interaction while claiming calm).
    // Its job is to fail the WRONG implementation: any fix that routes `pressed`
    // through suspendState()/suspendReason() lights the paused copy here. After
    // the real fix nothing is lost during a press — the value, the focus and now
    // the click all survive — so "not paused" is the truth, and printing
    // "paused — updating when you're done" would be the NEW lie.
    await boardWithAnswerButton()
    const pressed = answerBtn()!

    await toJustBeforeTick()
    pointer(pressed, 'pointerdown')
    await crossTick()

    expect(pauseHint()).toBe('')
  })

  // TITLE PRECISION, deliberate: this test does NOT observe the release, and an
  // earlier title ("…once the button is up") promised that it did. `pollTick()`
  // advances 3000ms, which expires PRESS_GRACE_MS whether or not the pointerup was
  // ever seen — delete both release listeners and this still passes. What it does
  // prove, and what it is for, is that a deferral is BOUNDED: the frame is not
  // dropped, it lands on the app's own next tick. The release itself is pinned by
  // the two tests below, which put the tick INSIDE the grace window.
  it('a deferred frame is not a dropped one — it lands on the app\'s own next tick', async () => {
    const d = await boardWithAnswerButton()
    const pressed = answerBtn()!

    await toJustBeforeTick()
    pointer(pressed, 'pointerdown')
    // 10ms, not the harness default of a full second: the guard is TIME-bounded,
    // so a fixture that jumps the wall clock past PRESS_GRACE_MS expires the press
    // it is trying to model. (That it can be expired this easily is the point —
    // see the strand test below.)
    advanceClock(10)
    insertItem(d, { ...AGENT, kind: 'question', title: 'arrived mid-press' })
    await crossTick()
    expect(rowTitles(), 'the tick was deferred, so this is still off screen').not.toContain('arrived mid-press')

    // No active resume on pointerup, on purpose: Chrome dispatches
    // pointerup → mouseup → click, so rendering from the pointerup handler would
    // rebuild the DOM before `click` and eat the very click being protected. The
    // frame simply lands on the app's own next tick.
    pointer(pressed, 'pointerup')
    await pollTick()

    expect(rowTitles()).toContain('arrived mid-press')
    expect(document.contains(pressed), 'and the rebuild does happen — this is a defer, not a freeze').toBe(false)
  })

  it('a completed click does not defer the frames that come after it', async () => {
    // THE RELEASE, isolated. `toJustBeforeTick(200)` parks the clock 200ms out;
    // the press is taken and GIVEN BACK inside that window, so the tick lands
    // 200ms after `pressedAt` — well inside PRESS_GRACE_MS. Whether it renders is
    // therefore decided by one thing only: was the pointerup observed.
    //
    // Deleting the release listeners passes every other test in this file, because
    // a press can only ever straddle ONE tick (3000ms poll, 1000ms grace) and the
    // NEXT tick is 3000ms out — past the grace, so it renders either way. This is
    // the arrangement where the two implementations disagree.
    const d = await boardWithAnswerButton()
    const pressed = answerBtn()!

    await toJustBeforeTick(200)
    pointer(pressed, 'pointerdown')
    await vi.advanceTimersByTimeAsync(50)
    pointer(pressed, 'pointerup') // …the human is done; the click has been dispatched
    advanceClock(10)
    insertItem(d, { ...AGENT, kind: 'question', title: 'arrived after the click' })
    await crossTick(150)

    expect(rowTitles(), 'the button is UP — a released press must not hold the poll for another second')
      .toContain('arrived after the click')
  })

  it('a cancelled press releases too — pointercancel is the touch/drag-away path', async () => {
    // The other half of the same listener pair. Chrome fires `pointercancel`
    // instead of `pointerup` when the gesture is stolen (scroll takes over the
    // touch, the pointer is captured elsewhere): no click will ever come, so the
    // rebuild has nothing left to protect and must resume immediately.
    const d = await boardWithAnswerButton()
    const pressed = answerBtn()!

    await toJustBeforeTick(200)
    pointer(pressed, 'pointerdown')
    await vi.advanceTimersByTimeAsync(50)
    pointer(pressed, 'pointercancel')
    advanceClock(10)
    insertItem(d, { ...AGENT, kind: 'question', title: 'arrived after the cancel' })
    await crossTick(150)

    expect(rowTitles(), 'a cancelled gesture protects nothing and must not defer anything')
      .toContain('arrived after the cancel')
  })

  it('a press whose release is never seen still expires — it cannot strand the viewer', async () => {
    // The C1 lesson, applied at design time: any suspend key whose only clearing
    // path is an event that may never arrive (button released outside the window,
    // a pointercancel that is never delivered) freezes the viewer forever.
    // `pressHeld` is a timestamp comparison, so worst case is one wasted click.
    const d = await boardWithAnswerButton()
    const pressed = answerBtn()!

    await toJustBeforeTick()
    pointer(pressed, 'pointerdown')
    advanceClock(10)
    insertItem(d, { ...AGENT, kind: 'question', title: 'still alive' })

    // the first tick lands inside the grace and IS deferred; the second is >1s
    // past the press, so it renders even though the button is still down
    await pollTick() // …and no pointerup, ever
    await pollTick()

    expect(rowTitles(), 'a press must never be able to freeze the poll').toContain('still alive')
    expect(listBoards(d).length).toBe(1)
  })
})

// ── the rejected fix, made unshippable ───────────────────────────────────────
// The header of this file argues why D2 is NOT fixed by adding `openRows` to
// `suspendState()`. Nothing enforced that argument: the one-line mutation
// `expanded: openRowId ? [openRowId, ...openRows] : [...openRows]` passed the
// entire suite — every press-guard test above included, because it defers the
// same ticks for a different (wrong) reason. So the loudest new invariant in the
// change was the only one a future "consistency" cleanup could delete in green.
//
// This is the test it fails, and the cost is exactly what it prints: expand ONE
// matrix row and the whole viewer stops — the Needs-you list, the document-title
// badge and #pauseHint — for as long as that row is open, which is unbounded
// because `openRows` is never pruned and has no reconciliation (the C1 lesson —
// see the comment over `const openRows` in public/app.js, and poll.js's
// reconcileOpenRow, which exists because that mistake already shipped once). A badge that
// stops counting while the human works is the bug #38 exists to close, wearing a
// different hat.
//
// Behavioural rather than a source pin, because the cost is observable and a
// behavioural test catches shapes the source text cannot: `openRows` routed into
// shouldDeferRender(), or into `drafts` instead of `expanded`, or pruned-then-fed
// all fail right here. test/shell.test.ts carries a source pin as well — that one
// fails AT the edit, naming the invariant, which is what the author of the
// cleanup actually reads.
describe('#38 · D2 — the REJECTED fix: an expanded matrix row must never suspend the poll', () => {
  it('a row left open in the matrix freezes nothing — not the list, not the badge, not the hint', async () => {
    const d = await boardWithAnswerButton()
    answerBtn()!.click()
    await settle()
    expect(document.querySelector('#boards .row-panel'), 'the row must really be expanded').not.toBeNull()
    expect(badgeCount(), 'one blocked row is waiting on the human').toBe(1)

    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'arrived while a row was open' })
    await pollTick()
    await pollTick()

    expect(document.querySelector('#boards .row-panel'), '…and still expanded, or this proves nothing').not.toBeNull()
    expect(rowTitles(), 'an expanded matrix row must not hold the 3s poll — openRows is not a suspend key')
      .toContain('arrived while a row was open')
    expect(badgeCount(), 'the badge stopped counting while a row was open — that is the C1 freeze again').toBe(2)
    expect(pauseHint(), 'nothing is being held back, so the viewer must not claim to be paused').toBe('')
  })
})
