// @vitest-environment jsdom
// Issue #247: rows that wait in Later or in the snoozed and pinned folds are
// dimmed, but an open card inside them never is. At desktop widths the card is
// a fixed inspector that still lives inside its row, and an ancestor's opacity
// would fade the whole inspector with it. Its own file: the attached
// stylesheet stays in this file's document for every later boot.
//
// Opacity is a plain number, which jsdom resolves through the real cascade; the
// rules involved sit outside the @media layer jsdom cannot evaluate.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, pinItem, snoozeItem } from '../../src/store.js'
import { attachStylesheet, bootApp, click, freshDb, row, settle, showInbox, useDomTest } from './harness.js'

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

describe('dimming deferred rows, never the open card (#247)', () => {
  it.each([
    ['the Later section', 'true', '.later-section', 'pinned'],
    ['the pinned fold', 'false', '.pinned-fold', 'pinned'],
    ['the snoozed fold', 'false', '.snoozed-fold', 'snoozed'],
  ] as const)('%s dims its rows but not an open card', async (_label, setting, selector, reason) => {
    localStorage.setItem('agent-inbox-later-section', setting)
    attachStylesheet()
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Set aside', detail: 'Read it later.' })
    if (reason === 'pinned') pinItem(db, id, true)
    else snoozeItem(db, id, new Date(Date.now() + 4 * 60 * 60_000).toISOString())
    await bootApp(db)
    await showInbox()
    const container = document.querySelector<HTMLDetailsElement>(`#needsYouList ${selector}`)!
    container.open = true
    container.dispatchEvent(new Event('toggle'))
    click(row(id))
    await settle()

    expect(effectiveOpacity(row(id)?.querySelector('.nrow-card'))).toBe(1)
    expect(effectiveOpacity(row(id)?.querySelector('.nrow-l1'))).toBeCloseTo(0.78)
    expect(effectiveOpacity(row(id)?.querySelector('.nrow-l2'))).toBeCloseTo(0.78)
  })
})
