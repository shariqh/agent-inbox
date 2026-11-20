// @vitest-environment jsdom
// UX pass, slice 1: an ask is drawn as its question, at most one line of why
// and its answers; everything else is one step away. What is hidden at rest is
// hidden by CSS, so these tests pin the DOM that stays reachable and, with
// public/style.css attached, the rules that decide what shows.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listBoards, upsertBoard } from '../../src/store.js'
import {
  bootApp, buttonLabelled, click, freshDb, pollTick, repaint, row, settle, showInbox, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

// the slice's own block at the end of the stylesheet
const css = readFileSync(new URL('../../public/style.css', import.meta.url), 'utf8')
const block = css.slice(css.indexOf('/* UX pass, slice 1: the ask */'))
const rule = (selector: string) => {
  const at = block.indexOf(`${selector} {`)
  return at < 0 ? '' : block.slice(at, block.indexOf('}', at) + 1)
}

function question(d: Database.Database, extra: Record<string, unknown> = {}): string {
  return insertItem(d, {
    ...AGENT,
    kind: 'question',
    title: 'Choose the rollout',
    options: [
      { label: 'Canary', detail: 'Check a small group first, then widen.', recommended: true },
      { label: 'Full rollout', detail: 'Update every customer at once.' },
    ],
    ...extra,
  })
}

describe('option details (UX ask, point 2)', () => {
  it('cuts a detail to one line at rest and only there, never in the session panel', () => {
    const scope = ':is(.card, .lb-row-card, .row-panel, .nrow-card-compose)'
    expect(rule(`${scope} .options:not(.comparing) .opt-detail`)).toMatch(/display:\s*-webkit-box;[^}]*overflow:\s*hidden;[^}]*-webkit-line-clamp:\s*1/)
    expect(rule(`${scope} .opt-detail`)).toMatch(/font-size:\s*13px/)
    expect(rule(`${scope} .opt-pill`)).toMatch(/min-height:\s*44px;[^}]*font-size:\s*15px;[^}]*font-weight:\s*600/)
    expect(block).not.toMatch(/\.sp-ask/)
  })

  it('starts every ask with one-line details; Compare shows them in full and Hide returns, across repaints', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    const options = () => row(id)!.querySelector<HTMLElement>('.nrow-card-compose > .options')!
    expect(options().classList.contains('comparing')).toBe(false)
    expect([...options().querySelectorAll('.opt-detail')].map((el) => el.textContent))
      .toEqual(['Check a small group first, then widen.', 'Update every customer at once.'])
    expect(buttonLabelled('Compare options', options())).not.toBeNull()

    click(buttonLabelled('Compare options', options()))
    await settle()
    expect(options().classList.contains('comparing')).toBe(true)
    await pollTick()
    await repaint()
    expect(options().classList.contains('comparing')).toBe(true)
    expect(buttonLabelled('Hide option details', options())).not.toBeNull()

    click(buttonLabelled('Hide option details', options()))
    await settle()
    await pollTick()
    expect(options().classList.contains('comparing')).toBe(false)
    expect(buttonLabelled('Compare options', options())).not.toBeNull()
  })

  it('keeps one state per ask: opening one ask’s details leaves another’s one-line', async () => {
    db = freshDb()
    const first = question(db)
    const second = question(db, { title: 'Choose the region' })
    upsertBoard(db, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Region',
        status: 'blocked',
        options: [{ label: 'EU', detail: 'Closer to most customers.' }, { label: 'US', detail: 'Cheaper.' }],
      }],
    })
    const rowId = listBoards(db)[0]!.rows[0]!.id
    await bootApp(db)
    await showInbox()
    click(row(first))
    await settle()
    click(buttonLabelled('Compare options', row(first)!))
    await settle()
    click(row(second))
    await settle()
    expect(row(second)!.querySelector('.options')?.classList.contains('comparing')).toBe(false)
    click(row(rowId))
    await settle()
    expect(row(rowId)!.querySelector('.row-options')?.classList.contains('comparing')).toBe(false)
    click(row(first))
    await settle()
    expect(row(first)!.querySelector('.options')?.classList.contains('comparing')).toBe(true)
  })
})
