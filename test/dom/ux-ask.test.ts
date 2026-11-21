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
import { insertItem, listBoards, markRowHandled, replyItem, upsertBoard } from '../../src/store.js'
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
const rule = (selector: string, source = block) => {
  const at = source.indexOf(`${selector} {`)
  return at < 0 ? '' : source.slice(at, source.indexOf('}', at) + 1)
}
// the open card's wide-window layout sits beside its base rules, ahead of the one responsive block
const responsiveAt = css.indexOf('@media (max-width: 1279px)')
const wide = css.slice(css.indexOf('/* UX pass, slice 1 (from the real app'), responsiveAt)
const press = (el: Element) => el.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
const release = (el: Element) => el.dispatchEvent(new window.Event('pointerup', { bubbles: true }))

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
  // the selector alone, without the comment above it
  const hideSelector = hideRule[1]!.split('*/').pop()!.trim()
  const shown = (el: HTMLElement) => !el.matches(hideSelector)

  it('hides it with a rule that keeps it in the DOM and focusable', () => {
    expect(hideRule[2]).toMatch(/position:\s*absolute/)
    expect(hideRule[2]).toMatch(/clip-path:\s*inset\(50%\)/)
    expect(hideRule[2]).not.toMatch(/display:\s*none|visibility:\s*hidden/)
  })

  it('never ties the context editor to focus: a row that enters the layout on a press moves the control under the pointer', () => {
    expect(hideSelector).not.toMatch(/:focus/)
    expect(hideSelector).toMatch(/:not\(\.shown, :has\(> \.reply-context-input:not\(:placeholder-shown\)\)\)/)
  })

  it('keeps the context editor out of sight through a press, and shows it once the click lands', async () => {
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
    // the press moves focus into the answer area: nothing may enter the layout yet
    const more = row(id)!.querySelector<HTMLElement>('.nrow-card-compose .disposition-menu > summary')!
    press(more)
    more.focus()
    expect(shown(contextRow(id))).toBe(false)
    release(more)
    expect(shown(contextRow(id))).toBe(false)
    click(more)
    expect(shown(contextRow(id))).toBe(true)
    // and it does not leave again when focus does: that would move the controls under the next press
    ;(document.activeElement as HTMLElement).blur()
    expect(shown(contextRow(id))).toBe(true)
    await repaint()
    expect(shown(contextRow(id))).toBe(true)
  })

  it('shows the context editor on keyboard focus, and draws it shown after a control that repaints', async () => {
    db = freshDb()
    const id = question(db)
    const second = question(db, { title: 'Second' })
    attachStylesheet()
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    answerInput(id)!.focus()
    expect(shown(contextRow(id))).toBe(true)
    // another ask opens at rest, and so does this one when it is opened again
    click(row(second))
    await settle()
    expect(shown(contextRow(second))).toBe(false)
    click(buttonLabelled('Compare options', row(second)!))
    await settle()
    expect(shown(contextRow(second))).toBe(true)
    click(row(id))
    await settle()
    expect(shown(contextRow(id))).toBe(false)
  })

  it('always shows a context editor that holds text', async () => {
    db = freshDb()
    const id = question(db)
    const second = question(db, { title: 'Second' })
    attachStylesheet()
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    type(contextInput(id), 'Ship on Friday')
    click(row(second))
    await settle()
    click(row(id))
    await settle()
    expect(contextInput(id).value).toBe('Ship on Friday')
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

  it('makes I’ve done my part the main control of a task row: first on its line, so Tab reaches it first', async () => {
    db = freshDb()
    upsertBoard(db, { ...AGENT, title: 'Launch', rows: [{ label: 'Upload', status: 'blocked', note: 'Ready.' }] })
    const rowId = listBoards(db)[0]!.rows[0]!.id
    await bootApp(db)
    await showInbox()
    click(row(rowId))
    await settle()
    const replyRow = row(rowId)!.querySelector('.nrow-card-compose .reply-row')!
    expect([...replyRow.children].map((el) => el.className || el.textContent))
      .toEqual(['handled-btn', 'reply-input', 'Send', 'write-error'])
    expect(buttonLabelled('I’ve done my part', replyRow)?.className).toBe('handled-btn')
    // where it is drawn is where it is in the DOM: no rule reorders the line
    expect(rule('.reply-row > .handled-btn:not(.undo-btn)')).not.toMatch(/order:/)
    expect(rule('.reply-row > .handled-btn:not(.undo-btn)')).toMatch(/background:\s*var\(--app-accent\)/)
  })

  it('keeps the undo of I’ve done my part after Send', async () => {
    db = freshDb()
    upsertBoard(db, { ...AGENT, title: 'Launch', rows: [{ label: 'Upload', status: 'blocked', note: 'Ready.' }] })
    const rowId = listBoards(db)[0]!.rows[0]!.id
    markRowHandled(db, rowId)
    await bootApp(db)
    await showInbox()
    click(row(rowId))
    await settle()
    const replyRow = row(rowId)!.querySelector('.nrow-card-compose .reply-row')!
    expect([...replyRow.children].map((el) => el.className || el.textContent))
      .toEqual(['reply-input', 'Send', 'handled-btn undo-btn', 'write-error'])
  })

  it('builds a plan step’s answer area in the order it is drawn, so Tab follows what is seen', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Region',
        status: 'blocked',
        note: 'Two regions fit.',
        next_step: 'Choose the region.',
        action_owner: 'decision',
        impact: 'The server waits.',
        options: [{ label: 'Near', detail: 'Faster.', recommended: true }, { label: 'Cheap', detail: 'Slower.' }],
      }],
    })
    const rowId = listBoards(db)[0]!.rows[0]!.id
    await bootApp(db)
    await showInbox()
    click(row(rowId))
    await settle()
    const answer = row(rowId)!.querySelector('.nrow-card-compose > .row-answer')!
    expect([...answer.children].map((el) => el.className.split(' ')[0]))
      .toEqual(['options', 'compare-toggle', 'reply-row', 'disposition-menu', 'wait-stop'])
    expect(css).not.toMatch(/\.row-answer > [^{]*\{[^}]*\border:/)
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
    expect(rule(':is(.lb-card > .card, .nrow-card-compose) > .actions button')).toMatch(/border-color:\s*transparent/)
  })
})

describe('the Inbox list row (UX ask, point 4)', () => {
  const chip = (id: string) => row(id)!.querySelector<HTMLElement>('.nrow-meta > .chip')!

  it('marks chip-rest only on a chip that says the ask waits on you', async () => {
    db = freshDb()
    const queued = question(db)
    const answered = question(db, { title: 'Already answered' })
    replyItem(db, answered, 'Canary')
    upsertBoard(db, { ...AGENT, title: 'Launch', rows: [{ label: 'Upload', status: 'blocked', note: 'Ready.' }] })
    const rowId = listBoards(db)[0]!.rows[0]!.id
    await bootApp(db)
    await showInbox()
    expect(chip(queued).textContent).toContain('Queued')
    expect(chip(queued).classList.contains('chip-rest')).toBe(true)
    expect(chip(rowId).textContent).toContain('Needs input')
    expect(chip(rowId).classList.contains('chip-rest')).toBe(true)
    expect(chip(answered).textContent).toContain('Answered')
    expect(chip(answered).classList.contains('chip-rest')).toBe(false)
  })

  it('draws a row as one line at rest: dot, title, change marker, a telling chip and the short age', async () => {
    db = freshDb()
    const id = question(db, { detail: 'A second line that stays in the DOM.' })
    upsertBoard(db, { ...AGENT, title: 'Launch', rows: [{ label: 'Upload', status: 'blocked', note: 'Ready.' }] })
    const rowId = listBoards(db)[0]!.rows[0]!.id
    attachStylesheet()
    await bootApp(db)
    await showInbox()
    const display = (el: Element | null) => (el ? getComputedStyle(el).display : 'absent')
    for (const target of [id, rowId]) {
      const el = row(target)!
      for (const selector of ['.nrow-proj', '.nrow-owner', '.nrow-session', '.chip-rest', '.nrow-src', '.nrow-l2']) {
        const part = el.querySelector(selector)
        if (part) expect(display(part), `${selector} on ${target}`).toBe('none')
      }
      for (const selector of ['.pdot', '.nrow-title', '.nrow-asked']) expect(display(el.querySelector(selector)), selector).not.toBe('none')
    }
    expect(row(id)!.querySelector('.nrow-l2')?.textContent).toContain('A second line')
    expect(getComputedStyle(row(id)!.querySelector('.nrow-title')!).whiteSpace).toBe('nowrap')
  })

  it('shows ★ and ✕ on the selected and the open row only, and never the caret; Wake and a staged state always', async () => {
    db = freshDb()
    const id = question(db)
    const other = question(db, { title: 'Second' })
    attachStylesheet()
    await bootApp(db)
    await showInbox()
    const display = (target: string, selector: string) => getComputedStyle(row(target)!.querySelector(selector)!).display
    expect(rule('.nrow > .nrow-l1 .nrow-caret')).toMatch(/display:\s*none/)
    click(row(id))
    await settle()
    for (const selector of ['.nrow-star', '.nrow-dismiss']) {
      // taken out of the line at rest, so the age ends every row at the same place
      expect(display(id, selector), selector).not.toBe('none')
      expect(display(other, selector), selector).toBe('none')
    }
    for (const target of [id, other]) expect(display(target, '.nrow-caret'), target).toBe('none')
    // a staged star ("Sent: … — Undo") is never one of the hidden ones
    expect(block).toMatch(/\.nrow-star:not\(:has\(\.undo-btn\)\)/)
    expect(block).toMatch(/\.nrow > \.nrow-l2:not\(:has\(\.undo-btn\)\)/)
    expect(block).not.toMatch(/\.nrow-wake[^{]*\{[^}]*(?:opacity:\s*0|display:\s*none)/)
  })

  it('keeps a plan step’s way to its plan: the Plan button shows on the row you are on, after the title', async () => {
    db = freshDb()
    const id = question(db)
    upsertBoard(db, { ...AGENT, title: 'Launch', rows: [{ label: 'Upload', status: 'blocked', note: 'Ready.' }] })
    const rowId = listBoards(db)[0]!.rows[0]!.id
    attachStylesheet()
    await bootApp(db)
    await showInbox()
    const plan = () => row(rowId)!.querySelector<HTMLElement>('.nrow-glyph')!
    // the keyboard's row is one you are on; with another row open, this one is at rest
    click(row(id))
    await settle()
    expect(row(rowId)!.classList.contains('selected')).toBe(false)
    expect(getComputedStyle(plan()).display).toBe('none')
    click(row(rowId))
    await settle()
    expect(getComputedStyle(plan()).display).not.toBe('none')
    expect(getComputedStyle(plan()).order).toBe('1')
    click(plan())
    await settle()
    expect(document.querySelector<HTMLElement>('.tab[aria-selected="true"]')?.dataset.tab).toBe('boards')
  })

  it('cuts the title, never a control: a long title cannot squeeze ★ onto ✕', () => {
    expect(rule('.nrow > .nrow-l1 > .nrow-primary')).toMatch(/flex:\s*1 1 0;[^}]*min-width:\s*30%/)
    expect(rule('.nrow > .nrow-l1 :is(.nrow-glyph, .nrow-dismiss, .nrow-wake, .nrow-star:not(:has(.undo-btn)))')).toMatch(/flex:\s*0 0 auto/)
    expect(rule('.nrow > .nrow-l1 .nrow-title')).toMatch(/overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/)
  })
})

describe('the open card in a wide window (UX ask, from the real app)', () => {
  it('hugs its content up to a height it names, and caps the question by that height, not by the card’s', () => {
    expect(rule('.nrow-card', wide)).toMatch(/--card-max:\s*calc\(100dvh - 144px\);[^}]*bottom:\s*auto;[^}]*max-height:\s*var\(--card-max\)/)
    // a share of an auto-height card is no cap at all
    expect(rule('.nrow-card-head', wide)).toMatch(/max-height:\s*calc\(var\(--card-max\) \* \.4\)/)
    expect(rule('.nrow-card-head', wide)).not.toMatch(/%/)
  })

  it('lets Details give way before the answers, and keeps a floor under each', () => {
    expect(rule('.nrow-card-scroll', wide)).toMatch(/flex:\s*0 100000 auto;[^}]*min-height:\s*min\(44px, calc\(var\(--card-max\) \* \.12\)\)/)
    expect(rule('.nrow-card-compose', wide)).toMatch(/flex:\s*0 1 auto;[^}]*min-height:\s*min\(120px, calc\(var\(--card-max\) \* \.3\)\)/)
    // opened, Details is being read: it shares the room instead of shrinking to its line
    expect(rule('.nrow-card-scroll:has(.card-context[open])', wide)).toMatch(/flex-shrink:\s*1/)
  })

  it('leaves the phone sheet, which has a height, its own cap on the question', () => {
    const phone = css.slice(css.indexOf('@container needs-queue (max-width: 440px)', responsiveAt))
    expect(rule('.nrow-card-head', phone)).toMatch(/max-height:\s*40%/)
  })
})

describe('the Inbox list row, continued (UX ask, point 4)', () => {
  it('keeps the row’s other parts in the DOM', async () => {
    db = freshDb()
    const id = question(db, { detail: 'A second line that stays in the DOM.' })
    await bootApp(db)
    await showInbox()
    expect(row(id)!.querySelector('.nrow-l2')?.textContent).toContain('A second line')
  })
})

describe('the inspector head (UX ask, point 6)', () => {
  it('names the project only under the title; the agent stays in Details', async () => {
    db = freshDb()
    const id = question(db)
    question(db, { agent: 'claude-code', title: 'A second agent in the project names agents on rows' })
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    expect(row(id)!.querySelector('.nrow-agent')?.textContent).toBe('copilot')
    const heading = row(id)!.querySelector('.nrow-card-head > div')!
    expect(heading.querySelector(':scope > span')?.textContent).toBe('alpha')
    expect(row(id)!.querySelector('.card-context .card-meta')?.textContent).toContain('copilot')
    expect(rule('.nrow-card-head .nrow-show-agents')).toMatch(/font-weight:\s*500/)
    // the head's title leads, at one class so the phone sheet's own size still wins
    expect(rule(':where(.nrow-card-head > div, .lb-card > .card, .lb-row-card, .row-panel) > .card-title')).toMatch(/font-size:\s*24px;[^}]*font-weight:\s*700;[^}]*line-height:\s*1\.2/)
  })
})

describe('shortcut tiles (UX ask, point 7)', () => {
  const keysShown = () => document.documentElement.classList.contains('keys-shown')

  it('draws no tile at rest and every tile while Show keys is on, the shortcuts decorated either way', async () => {
    db = freshDb()
    const id = question(db)
    attachStylesheet()
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    expect(rule(':root:not(.keys-shown) [data-shortcut]::after')).toMatch(/display:\s*none/)
    expect(rule(':root:not(.keys-shown) .floating-search-key')).toMatch(/display:\s*none/)
    expect(keysShown()).toBe(false)
    const pills = [...row(id)!.querySelectorAll('.opt-pill')]
    expect(pills.map((pill) => pill.getAttribute('data-shortcut'))).toEqual(['1', '2'])
    expect(document.querySelector('[data-tab="needsYou"]')?.getAttribute('data-shortcut')).toBe('G I')
    expect(buttonLabelled('Send', row(id)!)?.getAttribute('data-shortcut')).toBeTruthy()
    const hints = document.getElementById('keyboardHints')!
    click(hints)
    expect(keysShown()).toBe(true)
    expect(hints.getAttribute('aria-pressed')).toBe('true')
    click(hints)
    expect(keysShown()).toBe(false)
  })
})
