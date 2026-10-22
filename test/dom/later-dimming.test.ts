// @vitest-environment jsdom
// Issue #247: rows that wait in Later, in the snoozed and pinned folds or in
// the stale fold are dimmed, but an open card inside them never is. At desktop
// widths the card is a fixed inspector that still lives inside its row, and an
// ancestor's opacity would fade the whole inspector with it and trap it in the
// fold's stacking context. Its own file: the attached stylesheet stays in this
// file's document for every later boot.
//
// Opacity is a plain number, which jsdom resolves through the real cascade; the
// rules involved sit outside the @media layer jsdom cannot evaluate.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, pinItem, snoozeItem } from '../../src/store.js'
import { advanceClock, attachStylesheet, bootApp, click, freshDb, row, settle, showInbox, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function effectiveOpacity(element: Element | null | undefined): number {
  if (!element) throw new Error('effectiveOpacity(): nothing to measure')
  let product = 1
  for (let node: Element | null = element; node; node = node.parentElement) {
    const value = getComputedStyle(node).opacity
    product *= value === '' ? 1 : Number(value)
  }
  return product
}

describe('dimming folded rows, never the open card (#247)', () => {
  // The stale fold dims its rows and summary as much as it did when the whole
  // fold carried the opacity: 0.6.
  it.each([
    ['the Later section', 'true', '.later-section', 'pinned', 0.78],
    ['the pinned fold', 'false', '.pinned-fold', 'pinned', 0.78],
    ['the snoozed fold', 'false', '.snoozed-fold', 'snoozed', 0.78],
    ['the stale fold', 'true', '.stale-fold:not([data-deferred-fold]):not(.stale-drafts-fold)', 'stale', 0.6],
  ] as const)('%s dims its rows but not an open card', async (_label, setting, selector, reason, dim) => {
    localStorage.setItem('agent-inbox-later-section', setting)
    attachStylesheet()
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Set aside', detail: 'Read it later.' })
    if (reason === 'pinned') pinItem(db, id, true)
    else if (reason === 'snoozed') snoozeItem(db, id, new Date(Date.now() + 4 * 60 * 60_000).toISOString())
    else advanceClock(73 * 60 * 60_000)
    await bootApp(db)
    await showInbox()
    const container = document.querySelector<HTMLDetailsElement>(`#needsYouList ${selector}`)!
    container.open = true
    container.dispatchEvent(new Event('toggle'))
    click(row(id))
    await settle()

    expect(row(id)?.closest('details')).toBe(container)
    expect(getComputedStyle(container).opacity, 'no opacity, so no stacking context, on the fold').toBe('1')
    expect(effectiveOpacity(row(id)?.querySelector('.nrow-card'))).toBe(1)
    expect(effectiveOpacity(row(id)?.querySelector('.nrow-l1'))).toBeCloseTo(dim)
    expect(effectiveOpacity(row(id)?.querySelector('.nrow-l2'))).toBeCloseTo(dim)
    if (container.matches('.stale-fold')) expect(effectiveOpacity(container.querySelector('summary'))).toBeCloseTo(dim)
  })

  // The unsent-responses fold shares the stale fold's class but holds no rows or
  // inspector; it keeps its look: the whole fold at 0.6.
  it('leaves the unsent-responses fold as it was', () => {
    attachStylesheet()
    const fold = document.createElement('details')
    fold.className = 'stale-fold stale-drafts-fold'
    fold.innerHTML = '<summary>unsent responses (1)</summary><div class="stale-draft-line">Half an answer</div>'
    document.body.appendChild(fold)
    expect(getComputedStyle(fold).opacity).toBe('0.6')
    expect(effectiveOpacity(fold.querySelector('summary'))).toBeCloseTo(0.6)
    expect(effectiveOpacity(fold.querySelector('.stale-draft-line'))).toBeCloseTo(0.6)
    fold.remove()
  })
})
