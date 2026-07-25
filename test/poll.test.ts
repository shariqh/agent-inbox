// test/poll.test.ts
import { describe, it, expect } from 'vitest'
import {
  suspendReason,
  shouldSuspendRender,
  suspendHint,
  pinOrder,
  pendingCount,
  applyListUpdate,
  reconcileOpenRow,
} from '../public/poll.js'

describe('suspendReason', () => {
  it('is null when nothing is open and no draft has content', () => {
    expect(suspendReason({ expanded: [], drafts: { a: '', b: '   ' } })).toBeNull()
    expect(shouldSuspendRender({ expanded: [], drafts: {} })).toBe(false)
  })
  it('reports an expanded card', () => {
    expect(suspendReason({ expanded: ['i1'], drafts: {} })).toBe('expanded')
    expect(shouldSuspendRender({ expanded: new Set(['i1']), drafts: {} })).toBe(true)
  })
  it('reports a non-empty draft even with nothing expanded', () => {
    expect(suspendReason({ expanded: [], drafts: { 'i1:answer': 'ship it' } })).toBe('draft')
    expect(shouldSuspendRender({ expanded: [], drafts: { 'i1:answer': 'ship it' } })).toBe(true)
  })
  it('an expanded card outranks a draft — both suspend', () => {
    expect(suspendReason({ expanded: ['i1'], drafts: { x: 'hi' } })).toBe('expanded')
  })
  it('tolerates a state with no fields at all', () => {
    expect(shouldSuspendRender({})).toBe(false)
    expect(suspendReason({})).toBeNull()
  })
})

describe('suspendHint', () => {
  it('is the quiet paused copy while suspended, null otherwise', () => {
    expect(suspendHint({ expanded: ['i1'], drafts: {} })).toBe("paused — updating when you're done")
    expect(suspendHint({ expanded: [], drafts: {} })).toBeNull()
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

describe('pendingCount', () => {
  it('counts additions and removals', () => {
    expect(pendingCount(['a', 'b'], ['b', 'c'])).toBe(2)
    expect(pendingCount(['a'], ['a'])).toBe(0)
    expect(pendingCount([], ['a', 'b'])).toBe(2)
  })
})

describe('applyListUpdate', () => {
  it('applies, pinned, when the pointer is away from the list', () => {
    expect(applyListUpdate({ current: ['a', 'b'], incoming: ['b', 'a', 'c'], hovering: false }))
      .toEqual({ ids: ['a', 'b', 'c'], staged: null, pending: 0 })
  })
  it('stages while the pointer is over the list — rows never move under a click', () => {
    const r = applyListUpdate({ current: ['a', 'b'], incoming: ['b', 'c'], hovering: true })
    expect(r.ids).toEqual(['a', 'b'])
    expect(r.staged).toEqual(['b', 'c'])
    expect(r.pending).toBe(2)
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
