// @vitest-environment jsdom
// test/dom/advanced-row-repaint.test.ts
//
// Issue #563: the installed app kept showing an answered row's old step as
// "Waiting for delivery" for about two hours after its agent advanced it with
// board_advance. The server and the poll were right; the paint was held. A
// question draft typed hours earlier (still in the profile's draft store through
// the whole incident) suspended every editable list, as §10 then did for any
// draft, however long nobody had touched it. A draft now holds the rebuild only
// while it is in use (public/poll.js `draftInUse`).
import { describe, it, expect, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { advanceBoardRow, insertItem, listBoards, resolveItem, upsertActivity, upsertBoard } from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, click, freshDb, pollTick, row, sendButton, settle, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const
const TITLE = 'Mesh: publish an agent'
const LABEL = '#533 design'
// past the two-minute hold, with no input to the window in between
const AWAY_MS = 10 * 60_000

function seedRow(d: Database.Database, labels = [LABEL]): string[] {
  upsertBoard(d, {
    ...AGENT, title: TITLE,
    rows: labels.map((label) => ({ label, status: 'blocked' as const, note: `${label} is ready.`, next_step: 'Choose a design', action_owner: 'decision' as const, impact: 'Unblocks the build.' })),
  })
  const rows = listBoards(d)[0]!.rows
  return labels.map((label) => rows.find((r) => r.label === label)!.id)
}

// exactly the store call the board_advance tool makes
function advance(d: Database.Database): void {
  const board = listBoards(d)[0]!
  const r = board.rows.find((x) => x.label === LABEL)!
  const res = advanceBoardRow(d, {
    project: AGENT.project, title: TITLE, label: LABEL, agent: AGENT.agent,
    expectedBoardVersion: board.revision, expectedRevision: r.revision,
    note: 'Design A is in.', next_step: 'Choose the rollout', action_owner: 'decision', impact: 'Ships it.',
  })
  expect(res.ok).toBe(true)
}

async function openAndType(id: string, text: string): Promise<void> {
  click(row(id))
  await settle()
  type(answerInput(id), text)
}

async function answer(id: string, text: string): Promise<void> {
  await openAndType(id, text)
  click(sendButton(id))
  await settle()
}

const chip = (id: string): string => {
  const el = row(id)?.querySelector('.chip')
  return [...(el?.childNodes ?? [])].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim()
}
const pauseHint = (): string => {
  const el = document.getElementById('pauseHint')
  return el && !el.hidden ? el.textContent ?? '' : ''
}
const unsent = (): string => document.querySelector('#needsYouList .stale-drafts-fold')?.textContent ?? ''
const stored = (): string => localStorage.getItem('agent-inbox-drafts-v1') ?? ''
const activeTab = (): string | undefined => document.querySelector<HTMLElement>('.tab[aria-selected="true"]')?.dataset.tab

describe('#563 · an idle draft never keeps an advanced row on its old step', () => {
  it('repaints the advanced row once the window has had no input for two minutes, keeping the draft', async () => {
    const d = (db = freshDb())
    const [rowId] = seedRow(d) as [string]
    advanceClock()
    const question = insertItem(d, { ...AGENT, kind: 'question', title: 'Keep the Sessions line?' })
    await bootApp(d)
    await showInbox()
    // a half-typed answer left behind, then the row answered
    await openAndType(question, 'Keep it, but')
    await answer(rowId, 'Design A')
    expect(chip(rowId)).toBe('Waiting for delivery')

    advanceClock(60_000)
    advance(d)
    await pollTick()
    // while the human may still be writing, §10 holds the list, and says so
    expect(chip(rowId)).toBe('Waiting for delivery')
    expect(pauseHint()).toContain('paused')

    advanceClock(AWAY_MS)
    await pollTick()
    expect(chip(rowId)).toBe('Needs input')
    click(row(rowId))
    await settle()
    expect(row(rowId)?.querySelector('.nrow-card')?.textContent).toContain('Choose the rollout')
    expect(row(rowId)?.textContent).not.toContain('Saved · waiting for delivery')
    expect(pauseHint()).toBe('')
    // the draft is unsent work still: its editor gets it back, nothing was sent
    click(row(question))
    await settle()
    expect(answerInput(question)?.value).toBe('Keep it, but')
  })

  it('keeps holding while the draft’s editor has focus in a focused window, however idle', async () => {
    const d = (db = freshDb())
    const [rowId] = seedRow(d) as [string]
    advanceClock()
    const question = insertItem(d, { ...AGENT, kind: 'question', title: 'Keep the Sessions line?' })
    await bootApp(d)
    await showInbox()
    await answer(rowId, 'Design A')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await openAndType(question, 'Keep it, but')
    answerInput(question)!.focus()

    advanceClock(AWAY_MS)
    advance(d)
    await pollTick()
    expect(chip(rowId)).toBe('Waiting for delivery')
    expect(pauseHint()).toContain('paused')
    expect(document.activeElement).toBe(answerInput(question))
  })

  it('sets aside an idle draft whose own row was advanced, without switching tabs or attaching it to the new step', async () => {
    const d = (db = freshDb())
    const [rowId] = seedRow(d) as [string]
    await bootApp(d)
    await showInbox()
    await openAndType(rowId, 'Design B, actually')
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()

    advanceClock(AWAY_MS)
    advance(d)
    await pollTick()
    // the poll painted the lists, and navigated nowhere
    expect(activeTab()).toBe('dashboard')
    expect(pauseHint()).toBe('')
    expect(chip(rowId)).toBe('Needs input')
    expect(unsent()).toContain('Design B, actually')
    expect(stored()).toContain('Design B, actually')

    // the human's next frame shows it in the Inbox; the new step's editor is empty
    await showInbox()
    click(row(rowId))
    await settle()
    expect(row(rowId)?.querySelector('.nrow-card')?.textContent).toContain('Choose the rollout')
    expect(answerInput(rowId)?.value ?? '').toBe('')
    expect(unsent()).toContain('Design B, actually')
  })

  it('sets aside an idle draft whose question an agent resolved, without switching tabs', async () => {
    const d = (db = freshDb())
    seedRow(d)
    advanceClock()
    const question = insertItem(d, { ...AGENT, kind: 'question', title: 'Keep the Sessions line?' })
    await bootApp(d)
    await showInbox()
    await openAndType(question, 'Keep it, but')
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()

    advanceClock(AWAY_MS)
    resolveItem(d, question)
    await pollTick()
    expect(activeTab()).toBe('dashboard')
    expect(pauseHint()).toBe('')
    expect(row(question)).toBeNull()
    expect(unsent()).toContain('Keep it, but')
    expect(stored()).toContain('Keep it, but')
  })
})

describe('#563 · the session panel', () => {
  it('a background window shows the advanced row as an ask again once the human has been away two minutes', async () => {
    const d = (db = freshDb())
    upsertActivity(d, { ...AGENT, session: 'here', doing: 'Working', idle: false })
    const [rowId, other] = seedRow(d, [LABEL, 'Rotate the token']) as [string, string]
    await bootApp(d)
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    click(document.querySelector('#dashboard [data-session-card="session:here"] [data-ah-action="review"]'))
    await settle()
    const panel = (): HTMLElement => document.querySelector<HTMLElement>('#dashboard .dash-focus')!
    const block = (id: string): HTMLElement | null => panel().querySelector<HTMLElement>(`[data-panel-ask="${id}"]`)
    const editor = block(rowId)!.querySelector<HTMLTextAreaElement>('.reply-input')!
    editor.focus()
    type(editor, 'Design A')
    click([...block(rowId)!.querySelectorAll('button')].find((b) => b.textContent === 'Send'))
    await settle()
    // the answered row became a dimmed line, and focus moved to the next ask
    expect(block(rowId)).toBeNull()
    expect(block(other)?.contains(document.activeElement)).toBe(true)

    // the human goes back to the terminal, leaving the window visible
    focus.mockReturnValue(false)
    advanceClock(60_000)
    advance(d)
    await pollTick()
    expect(block(rowId), 'a window just left keeps its remembered focus in place').toBeNull()

    const calls = vi.spyOn(HTMLElement.prototype, 'focus')
    advanceClock(AWAY_MS)
    await pollTick()
    expect(block(rowId)).not.toBeNull()
    expect(block(rowId)?.textContent).toContain('Choose the rollout')
    expect(panel().querySelector('.sp-answered')).toBeNull()
    expect(calls, 'a background window never takes focus').not.toHaveBeenCalled()
  })
})
