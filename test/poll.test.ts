// test/poll.test.ts
import { describe, it, expect } from 'vitest'
import {
  suspendReason,
  shouldSuspendRender,
  suspendHint,
  pinOrder,
  pendingCount,
  applyListUpdate,
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
