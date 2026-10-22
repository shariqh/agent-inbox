// @vitest-environment jsdom
// Issue #272: a row snooze moves the row revision, so a draft on that row moves
// to the unsent responses, as any draft does when its action changes. When THIS
// window's own defer moved the revision, the row says the human set the ask
// aside, not that the action changed. The draft is never re-keyed: resending it
// is still the human's explicit step, against the current revision.
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
const SET_ASIDE = 'Kept from before you set this aside. Preserved answer: Half an answer'
const CHANGED = 'Not sent because this action changed. Preserved answer: Half an answer'

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

describe('a drafted plan row the human set aside (#272)', () => {
  it('says the human set it aside when snoozed from the list', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d)
    await draftOn(rowId)
    click(buttonLabelled('Not now · 4h', row(rowId)!))
    await settle()

    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.snoozed_until).not.toBeNull()
    expect(warnings(rowId)).toEqual([SET_ASIDE])
    expect(recoveryFold()?.textContent).toContain('answer: Half an answer')
    expect(answerInput(rowId)?.value, 'the draft is not re-attached to the new revision').toBe('')
    expect(bridge.posts.filter((post) => post.url.includes('/annotate'))).toHaveLength(0)
  })

  it('says the human set it aside after "I’ll take a while" → "Back in ~1 h" with the Later section on', async () => {
    const { d, rowId } = seed(COPILOT)
    await bootApp(d)
    await draftOn(rowId)
    click(waitChoice(rowId, 'Back in ~1 h'))
    await settle()

    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.snoozed_until).not.toBeNull()
    expect(warnings(rowId)).toEqual([SET_ASIDE])
  })

  it('still says the action changed when an agent edit moves the revision', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentEdit(d, AGENT, 'The 1.4.1 build is ready.')
    await pollTick()
    await repaint()

    expect(warnings(rowId)).toEqual([CHANGED])
  })

  it('still says the action changed when an agent edit beats the snooze click', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentEdit(d, AGENT, 'The 1.4.1 build is ready.')
    click(buttonLabelled('Not now · 4h', row(rowId)!))
    await settle()

    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.snoozed_until, 'the stale click is refused').toBeNull()
    expect(warnings(rowId)).toEqual([CHANGED])
  })

  it('fixes the reason when the entry is made: a later agent edit keeps the set-aside wording', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    click(buttonLabelled('Not now · 4h', row(rowId)!))
    await settle()
    expect(warnings(rowId)).toEqual([SET_ASIDE])

    agentEdit(d, AGENT, 'The 1.4.1 build is ready.')
    await pollTick()
    await repaint()
    expect(warnings(rowId)).toEqual([SET_ASIDE])
  })

  it('does not carry a pin (no revision move) into a later agent edit', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    click(buttonLabelled('Pin for later', row(rowId)!))
    await settle()
    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.pinned_at).not.toBeNull()
    expect(answerInput(rowId)?.value, 'a pin keeps the revision, so the draft stays').toBe('Half an answer')
    expect(warnings(rowId)).toEqual([])

    agentEdit(d, AGENT, 'The 1.4.1 build is ready.')
    await pollTick()
    await repaint()
    expect(warnings(rowId)).toEqual([CHANGED])
  })

  it('resends only when the human sends again, against the current revision', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d)
    await draftOn(rowId)
    click(buttonLabelled('Not now · 4h', row(rowId)!))
    await settle()
    await pollTick()
    await repaint()
    expect(warnings(rowId)).toEqual([SET_ASIDE])
    expect(bridge.posts.filter((post) => post.url.includes('/annotate'))).toHaveLength(0)

    const current = getBoard(d, 'alpha', 'Release')!
    type(answerInput(rowId), 'Half an answer')
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
