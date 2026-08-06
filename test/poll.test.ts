// test/poll.test.ts
import { describe, it, expect } from 'vitest'
import {
  suspendReason,
  shouldSuspendRender,
  suspendHint,
  pinOrder,
  reconcileOpenRow,
  pressHeld,
  scrollActive,
  shouldDeferRender,
  PRESS_GRACE_MS,
  SCROLL_IDLE_MS,
} from '../public/poll.js'

describe('suspendReason', () => {
  it('is null when nothing is open and no draft has content', () => {
    expect(suspendReason({ drafts: { a: '', b: '   ' } })).toBeNull()
    expect(shouldSuspendRender({ drafts: {} })).toBe(false)
  })
  it('does not suspend for a merely expanded card', () => {
    expect(suspendReason({ drafts: {} })).toBeNull()
    expect(shouldSuspendRender({ drafts: {} })).toBe(false)
  })
  it('reports a non-empty draft even with nothing expanded', () => {
    expect(suspendReason({ drafts: { 'i1:answer': 'ship it' } })).toBe('draft')
    expect(shouldSuspendRender({ drafts: { 'i1:answer': 'ship it' } })).toBe(true)
  })
  it('still reports a draft when its card is expanded', () => {
    expect(suspendReason({ drafts: { x: 'hi' } })).toBe('draft')
  })
  it('tolerates a state with no fields at all', () => {
    expect(shouldSuspendRender({})).toBe(false)
    expect(suspendReason({})).toBeNull()
  })
})

describe('suspendHint', () => {
  it('is the quiet paused copy while suspended, null otherwise', () => {
    expect(suspendHint({ drafts: { answer: 'half a thought' } })).toBe("paused — updating when you're done")
    expect(suspendHint({ drafts: {} })).toBeNull()
  })
})

describe('pinOrder', () => {
  it('keeps the on-screen order however the server re-sorts', () => {
    expect(pinOrder(['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual(['a', 'b', 'c'])
  })
  it('appends genuinely new ids at the foot, in incoming order', () => {
    expect(pinOrder(['a', 'b'], ['d', 'a', 'c', 'b'])).toEqual(['a', 'b', 'd', 'c'])
  })
  it('drops ids that are gone', () => {
    expect(pinOrder(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c'])
  })
  it('starts from empty', () => {
    expect(pinOrder([], ['a', 'b'])).toEqual(['a', 'b'])
  })
})

// Fix round 2 (C1): `openRowId` is module state whose ONLY clearing path was
// toggleRow — reachable exclusively from a `.nrow` element. A deep link that
// wrote a BOARD id (electron/main.cjs notifies a blocked row with
// focusHashFor(board.id)) or a notes/done item id into it therefore wedged
// shouldSuspendRender() on forever: the poll kept fetching, render() never ran
// again, and every tab count and the document title froze. The structural fix
// is this render-time reconciliation — whatever the render actually produced is
// the truth about what is still collapsible — so ANY future writer of openRowId
// inherits a clearing path instead of a permanent freeze.
describe('reconcileOpenRow', () => {
  it('keeps an open id that the render actually produced a row for', () => {
    expect(reconcileOpenRow('i1', ['i0', 'i1', 'i2'])).toBe('i1')
    expect(reconcileOpenRow('i1', new Set(['i1']))).toBe('i1')
  })
  it('clears an open id no row was rendered for — the freeze case', () => {
    expect(reconcileOpenRow('board-9', ['i0', 'i1'])).toBeNull()
    expect(reconcileOpenRow('note-1', [])).toBeNull()
  })
  it('is a no-op when nothing is open', () => {
    expect(reconcileOpenRow(null, ['i1'])).toBeNull()
    expect(reconcileOpenRow(undefined, undefined)).toBeNull()
  })
})

// ── issue #38 / D2: the press guard ──────────────────────────────────────────
// The measured failure is NOT "the panel was open". It is that the 3s rebuild
// landed BETWEEN pointerdown and pointerup, so the press target was detached and
// Chrome had no common ancestor to fire `click` on — no click event at all, on
// any surface (rail pills, tabs, Answer, Send, ★, the pager). Real-Chrome CDP
// measured 1 lost click in 24 at human hold times (≈ hold / 3000ms).
//
// So the gate is on the PRESS, not on hover, focus, or expansion. Two properties
// are load-bearing and both are pinned below:
//
//  1. It CANNOT STRAND. `pressHeld` is a timestamp comparison, not a flag — even
//     if every release event is missed (button let go outside the window, no
//     pointercancel) it self-heals within PRESS_GRACE_MS. That is the
//     `reconcileOpenRow` lesson ("one wasted click instead of a frozen viewer")
//     applied at the design level instead of patched afterwards. A press held
//     longer than the grace degrades to today's behaviour; never worse.
//  2. It is NOT A PAUSE, so it must never reach suspendReason()/suspendHint().
//     A bare press loses nothing (values and focus survive the rebuild; clicks
//     now do too), so printing "paused — updating when you're done" for it would
//     be a NEW lie in the hint. Keeping `pressedAt` out of the suspend vocabulary
//     is what makes the hint automatically truthful, and it is pinned here rather
//     than left to discipline.
describe('pressHeld (#38 · D2)', () => {
  const t = 1_000_000

  it('is false when no press is down', () => {
    expect(pressHeld(null, t)).toBe(false)
    expect(pressHeld(undefined, t)).toBe(false)
  })

  it('is true from the instant of the press', () => {
    expect(pressHeld(t, t)).toBe(true)
  })

  it('holds for the whole grace window and not one ms longer — it cannot strand', () => {
    expect(PRESS_GRACE_MS).toBe(1000)
    expect(pressHeld(t - (PRESS_GRACE_MS - 1), t)).toBe(true)
    expect(pressHeld(t - PRESS_GRACE_MS, t)).toBe(false)
    expect(pressHeld(t - 60_000, t), 'a press whose release was never seen must expire on its own').toBe(false)
  })
})

describe('shouldDeferRender (#38 · D2)', () => {
  const t = 1_000_000
  const idle = { drafts: {} }

  it('defers for a held press even though nothing is suspended', () => {
    expect(shouldDeferRender({ ...idle, pressedAt: t - 40 }, t)).toBe(true)
  })

  it('stops deferring once the grace has run out', () => {
    expect(shouldDeferRender({ ...idle, pressedAt: t - PRESS_GRACE_MS }, t)).toBe(false)
  })

  it('still defers for drafts, press or no press', () => {
    expect(shouldDeferRender({ drafts: {}, pressedAt: null }, t)).toBe(false)
    expect(shouldDeferRender({ drafts: { 'i1:answer': 'ship it' }, pressedAt: null }, t)).toBe(true)
  })

  it('is idle when nothing is expanded, nothing typed and no button is down', () => {
    expect(shouldDeferRender({ ...idle, pressedAt: null }, t)).toBe(false)
    expect(shouldDeferRender(idle, t), 'a state that never heard of presses still works').toBe(false)
  })
})

describe('active inspector scroll', () => {
  const t = 1_000_000

  it('defers inside the short idle window and self-heals at its boundary', () => {
    expect(SCROLL_IDLE_MS).toBe(200)
    expect(scrollActive(t - (SCROLL_IDLE_MS - 1), t)).toBe(true)
    expect(scrollActive(t - SCROLL_IDLE_MS, t)).toBe(false)
    expect(scrollActive(null, t)).toBe(false)
  })

  it('defers the editable rebuild without becoming a suspension', () => {
    const scrolling = { drafts: {}, scrolledAt: t - 40 }
    expect(shouldDeferRender(scrolling, t)).toBe(true)
    expect(suspendReason(scrolling)).toBeNull()
    expect(suspendHint(scrolling)).toBeNull()
  })
})

describe('a press is not a pause — the hint vocabulary never learns about it', () => {
  const t = 1_000_000

  it('suspendReason ignores pressedAt entirely', () => {
    expect(suspendReason({ drafts: {}, pressedAt: t })).toBeNull()
    expect(shouldSuspendRender({ drafts: {}, pressedAt: t })).toBe(false)
  })

  it('suspendHint stays null for a bare press — nothing is being held back from the human', () => {
    expect(suspendHint({ drafts: {}, pressedAt: t })).toBeNull()
  })
})
