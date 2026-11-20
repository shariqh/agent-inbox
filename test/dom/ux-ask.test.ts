// @vitest-environment jsdom
// UX pass, slice 1: an ask is drawn as its question, at most one line of why
// and its answers; everything else is one step away. What is hidden at rest is
// hidden by CSS, so these tests pin the DOM that stays reachable and, with
// public/style.css attached, the rules that decide what shows.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listBoards, upsertBoard } from '../../src/store.js'
import {
  answerInput, attachStylesheet, bootApp, buttonLabelled, click, freshDb, pollTick, repaint, row, settle, showInbox,
  type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

// the slice's own block at the end of the stylesheet
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'style.css'), 'utf8')
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

describe('the answer area (UX ask, point 3)', () => {
  const contextRow = (id: string) => row(id)!.querySelector<HTMLElement>('.nrow-card-compose > .options > .reply-context-row')!
  const contextInput = (id: string) => contextRow(id).querySelector<HTMLTextAreaElement>('.reply-context-input')!
  // jsdom keeps a computed style until the DOM changes, so a focus change is read
  // through the rule's own selector, against the live document
  const hideRule = block.match(/([^{}]*\.reply-context-row[^{}]*)\{([^}]*)\}/)!
  const shown = (el: HTMLElement) => !el.matches(hideRule[1]!.trim())

  it('hides it with a rule that keeps it in the DOM and focusable', () => {
    expect(hideRule[2]).toMatch(/position:\s*absolute/)
    expect(hideRule[2]).toMatch(/clip-path:\s*inset\(50%\)/)
    expect(hideRule[2]).not.toMatch(/display:\s*none|visibility:\s*hidden/)
  })

  it('hides the context editor at rest, shows it while focus is in the answer area or it holds text', async () => {
    db = freshDb()
    const id = question(db)
    attachStylesheet()
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    expect(contextInput(id).isConnected).toBe(true)
    expect(shown(contextRow(id))).toBe(false)
    expect(getComputedStyle(contextRow(id)).position).toBe('absolute')
    answerInput(id)!.focus()
    expect(shown(contextRow(id))).toBe(true)
    ;(document.activeElement as HTMLElement).blur()
    expect(shown(contextRow(id))).toBe(false)
    type(contextInput(id), 'Ship on Friday')
    ;(document.activeElement as HTMLElement)?.blur?.()
    expect(shown(contextRow(id))).toBe(true)
  })

  it('keeps a context draft and its focus across a repaint', async () => {
    db = freshDb()
    const id = question(db)
    attachStylesheet()
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    contextInput(id).focus()
    type(contextInput(id), 'Only after the backup')
    await repaint()
    expect(contextInput(id).value).toBe('Only after the backup')
    expect(document.activeElement).toBe(contextInput(id))
    expect(shown(contextRow(id))).toBe(true)
  })

  it('calls the secondary responses More, while the compact surface keeps More…', async () => {
    db = freshDb()
    const id = question(db)
    upsertBoard(db, { ...AGENT, title: 'Launch', rows: [{ label: 'Upload', status: 'blocked', note: 'Ready.' }] })
    const rowId = listBoards(db)[0]!.rows[0]!.id
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    expect(row(id)!.querySelector('.disposition-menu > summary')?.textContent).toBe('More')
    click(row(rowId))
    await settle()
    expect(row(rowId)!.querySelector('.disposition-menu > summary')?.textContent).toBe('More')
  })

  it('makes I’ve done my part the main control of a task row without moving it in the DOM', async () => {
    db = freshDb()
    upsertBoard(db, { ...AGENT, title: 'Launch', rows: [{ label: 'Upload', status: 'blocked', note: 'Ready.' }] })
    const rowId = listBoards(db)[0]!.rows[0]!.id
    await bootApp(db)
    await showInbox()
    click(row(rowId))
    await settle()
    const replyRow = row(rowId)!.querySelector('.nrow-card-compose .reply-row')!
    expect([...replyRow.children].map((el) => el.className || el.textContent))
      .toEqual(['reply-input', 'Send', 'handled-btn', 'write-error'])
    expect(buttonLabelled('I’ve done my part', replyRow)?.className).toBe('handled-btn')
    expect(rule('.reply-row > .handled-btn:not(.undo-btn)')).toMatch(/order:\s*-1/)
    expect(rule('.reply-row > .handled-btn:not(.undo-btn)')).toMatch(/background:\s*var\(--app-accent\)/)
  })

  it('keeps the card’s actions, quieter', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    const actions = row(id)!.querySelector('.nrow-card-compose > .actions')!
    expect([...actions.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Resolve', 'Dismiss', 'Note'])
    expect(actions.querySelector('[data-shortcut-id="resolve"]')).not.toBeNull()
    expect(rule(':is(.card, .nrow-card-compose) > .actions button')).toMatch(/border-color:\s*transparent/)
  })
})
