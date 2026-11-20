// @vitest-environment jsdom
// Issue #272 moved a draft to the unsent responses when a snooze moved its row's
// revision, saying the human had set the ask aside. Issue #636 replaced that: a
// snooze (or a pin, or "I'll take a while") leaves the ask's words alone, so the
// draft stays in its editor and follows the row; an agent's edit to those words
// keeps it there too, and the row says the ask was edited. Sending it is still
// the human's explicit step, against the current revision.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, updateBoardRow, upsertBoard } from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, click, freshDb, pollTick, repaint, row,
  sendButton, settle, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const
const COPILOT = { ...AGENT, agent: 'copilot' } as const
const EDITED = 'This ask was edited while you were typing. Read it again, then send.'

const blockedRow = {
  label: 'Install test',
  status: 'blocked' as const,
  note: 'The 1.4 build is ready.',
  next_step: 'Do the install test.',
  action_owner: 'task' as const,
  impact: 'Gates the release.',
}

function seed(agent: typeof AGENT | typeof COPILOT = AGENT): { d: Database.Database, rowId: string } {
  db = freshDb()
  upsertBoard(db, { ...agent, title: 'Release', rows: [blockedRow] })
  return { d: db, rowId: getBoard(db, 'alpha', 'Release')!.rows[0]!.id }
}

const warnings = (id: string) => [...(row(id)?.querySelectorAll('.stale-draft') ?? [])].map((el) => el.textContent)
const notice = (id: string) => row(id)?.querySelector('.ask-edited')?.textContent ?? null
const kept = (id: string) => {
  expect(answerInput(id)?.value).toBe('Half an answer')
  expect(warnings(id)).toEqual([])
  expect(recoveryFold()).toBeNull()
}
const recoveryFold = () => document.querySelector<HTMLDetailsElement>('#needsYouList .stale-drafts-fold')
const waitChoice = (id: string, label: string) => [...(row(id)?.querySelectorAll<HTMLButtonElement>('.wait-menu button') ?? [])]
  .find((button) => button.textContent === label) ?? null

function agentEdit(d: Database.Database, agent: typeof AGENT | typeof COPILOT, note: string): void {
  const board = getBoard(d, 'alpha', 'Release')!
  advanceClock()
  updateBoardRow(d, {
    ...agent,
    title: 'Release',
    label: blockedRow.label,
    expectedBoardVersion: board.revision,
    expectedRevision: board.rows[0]!.revision,
    note,
  })
}

async function draftOn(rowId: string): Promise<void> {
  await showInbox()
  click(row(rowId))
  await settle()
  type(answerInput(rowId), 'Half an answer')
}

describe('a drafted plan row the human set aside (#272, #636)', () => {
  it('keeps the draft in its editor when snoozed from the list', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d)
    await draftOn(rowId)
    click(buttonLabelled('Not now · 4h', row(rowId)!))
    await settle()

    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.snoozed_until).not.toBeNull()
    kept(rowId)
    expect(notice(rowId)).toBeNull()
    expect(bridge.posts.filter((post) => post.url.includes('/annotate'))).toHaveLength(0)
  })

  it('keeps it after "I’ll take a while" → "Back in ~1 h" with the Later section on', async () => {
    const { d, rowId } = seed(COPILOT)
    await bootApp(d)
    await draftOn(rowId)
    click(waitChoice(rowId, 'Back in ~1 h'))
    await settle()

    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.snoozed_until).not.toBeNull()
    kept(rowId)
  })

  it('keeps it and says the ask was edited when an agent edit moves the revision', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentEdit(d, AGENT, 'The 1.4.1 build is ready.')
    await pollTick()
    await repaint()

    kept(rowId)
    expect(notice(rowId)).toBe(EDITED)
  })

  it('refuses a snooze an agent edit beat, and keeps the draft with the edited ask', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentEdit(d, AGENT, 'The 1.4.1 build is ready.')
    click(buttonLabelled('Not now · 4h', row(rowId)!))
    await settle()

    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.snoozed_until, 'the stale click is refused').toBeNull()
    kept(rowId)
    expect(notice(rowId)).toBe(EDITED)
  })

  it('says the ask was edited when an agent edits it after the snooze', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    click(buttonLabelled('Not now · 4h', row(rowId)!))
    await settle()
    expect(notice(rowId)).toBeNull()

    agentEdit(d, AGENT, 'The 1.4.1 build is ready.')
    await pollTick()
    await repaint()
    kept(rowId)
    expect(notice(rowId)).toBe(EDITED)
  })

  it('says the ask was edited when an agent edits a pinned ask', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    click(buttonLabelled('Pin for later', row(rowId)!))
    await settle()
    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.pinned_at).not.toBeNull()
    kept(rowId)

    agentEdit(d, AGENT, 'The 1.4.1 build is ready.')
    await pollTick()
    await repaint()
    kept(rowId)
    expect(notice(rowId)).toBe(EDITED)
  })

  it('sends only when the human sends, against the current revision', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d)
    await draftOn(rowId)
    click(buttonLabelled('Not now · 4h', row(rowId)!))
    await settle()
    await pollTick()
    await repaint()
    expect(bridge.posts.filter((post) => post.url.includes('/annotate'))).toHaveLength(0)

    const current = getBoard(d, 'alpha', 'Release')!
    click(sendButton(rowId))
    await settle()

    const sent = bridge.posts.filter((post) => post.url.includes('/annotate'))
      .map((post) => JSON.parse(String(post.init?.body)))
    expect(sent).toEqual([expect.objectContaining({
      text: 'Half an answer',
      expected_revision: current.rows[0]!.revision,
      expected_board_version: current.revision,
    })])
    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.annotation).toBe('Half an answer')
  })
})
