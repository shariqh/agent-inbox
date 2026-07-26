// @vitest-environment jsdom
// test/dom/css-cascade.test.ts
// A deliberately NARROW slice: getComputedStyle over the real rendered board matrix
// with public/style.css attached, catching specificity regressions of the shape commit
// 13819d2 fixed ("(0,2,1) was silently beating (0,1,0)"): `.board-table .row-action
// button` quietly winning over `.answer-btn`, which turned the blocked-row Answer CTA
// from a 999px pill into a 6px rectangle.
//
// WHAT THIS FILE MAY ASSERT: literal lengths and keywords only.
// jsdom resolves specificity, source order, !important, :has() and color-mix(), but
//   · `@media` never matches (its evaluateMediaList only answers `all`/`screen`), so
//     the entire spec §14 responsive layer at style.css's tail is invisible here;
//   · `var()` is returned unresolved;
//   · any declaration jsdom cannot parse is dropped SILENTLY — e.g.
//     `border: 1px solid color-mix(…)` reads back as borderStyle 'none' /
//     borderTopWidth 'medium', so asserting the `.row-expand { border: none }` half of
//     that same historical bug would pass VACUOUSLY on the buggy sheet.
// See CLAUDE.md, "DOM harness — what it can and cannot see".
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { upsertBoard } from '../../src/store.js'
import { attachStylesheet, bootApp, click, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

async function boardWithBlockedRow(): Promise<void> {
  db = freshDb()
  upsertBoard(db, {
    ...AGENT, title: 'rollout',
    rows: [
      { label: 'needs a call', status: 'blocked', note: 'which region?' }, // → .answer-btn
      { label: 'has context', status: 'tracked', note: 'later', context: 'the long version' }, // → .row-expand
    ],
  })
  attachStylesheet()
  await bootApp(db)
  click(document.querySelector('.tab[data-tab="boards"]'))
  await settle()
}

describe('public/style.css parses as a whole', () => {
  it('exposes the full rule set, so a syntax error cannot silently disable half the cascade', async () => {
    await boardWithBlockedRow()
    const sheet = [...document.styleSheets].find((s) => s.cssRules.length > 0)
    expect(sheet, 'no stylesheet attached').toBeTruthy()
    // today's sheet parses to 240 rules with zero errors; a swallowed brace shows up
    // here as a cliff, not as a mysteriously unstyled element
    expect(sheet!.cssRules.length).toBeGreaterThan(200)
  })
})

describe('the blocked-row Answer CTA keeps its designed geometry', () => {
  it('.answer-btn is a 999px pill with 1px 10px padding, not the legacy 6px rect', async () => {
    await boardWithBlockedRow()

    const answer = document.querySelector('#boards .row-action .answer-btn')
    expect(answer, 'no .answer-btn rendered — the blocked row should emit one').not.toBeNull()
    const s = getComputedStyle(answer!)
    expect(s.borderRadius).toBe('999px')
    expect(s.padding).toBe('1px 10px')
    // NOT fontWeight. `.answer-btn` declares `font: inherit; … font-weight: 600`, and
    // jsdom reads that back as 'normal' — the shorthand clobbers the later longhand.
    // Measured, not assumed; see the blind-spot list in CLAUDE.md.
  })

  it('renders a .row-expand for the non-blocked row it shares a table with', async () => {
    // the structural half of the same regression: both controls must exist, so a
    // future change that collapses them into one shape is visible here
    await boardWithBlockedRow()
    expect(document.querySelectorAll('#boards .row-action .answer-btn').length).toBe(1)
    expect(document.querySelectorAll('#boards .row-action .row-expand').length).toBe(1)
  })
})
