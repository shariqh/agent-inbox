// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { advanceBoardRow, getBoard, upsertBoard } from '../../src/store.js'
import {
  answerInput, bootApp, buttonLabelled, click, freshDb, pollTick, searchFor, sendButton,
  settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

function recoveryLines(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.stale-drafts-fold .stale-draft-line')]
}

function clearRecovery(text: string): void {
  const line = recoveryLines().find((candidate) => candidate.textContent?.includes(text))
  if (!line) throw new Error(`missing recovery line: ${text}`)
  click(buttonLabelled('Clear', line))
}

describe('version-keyed row draft recovery', () => {
  it('preserves older action recovery through later success, refusal, and targeted clear', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Release',
      rows: [{
        label: 'Approve release',
        status: 'blocked',
        note: 'First action',
        context: 'First action context',
      }],
    })
    const first = getBoard(db, 'alpha', 'Release')!
    const rowId = first.rows[0]!.id
    await bootApp(db)

    click(document.querySelector(`[data-card-id="${rowId}"]`))
    await settle()
    type(answerInput(rowId), 'Revision one recovery')
    expect(advanceBoardRow(db, {
      project: 'alpha',
      title: 'Release',
      label: 'Approve release',
      expectedBoardVersion: first.revision,
      expectedRevision: first.rows[0]!.revision,
      note: 'Second action',
      next_step: 'Choose again.',
      action_owner: 'approval',
      impact: 'Unblocks release.',
      context: 'Second action context',
    }).ok).toBe(true)
    await pollTick()
    await searchFor('Approve release')

    expect(recoveryLines()).toHaveLength(1)
    expect(recoveryLines()[0]?.textContent).toContain('Revision one recovery')
    expect(recoveryLines()[0]?.textContent).toContain('First action context')

    type(answerInput(rowId), 'Revision two succeeds')
    click(sendButton(rowId))
    await settle()
    expect(recoveryLines()).toHaveLength(1)
    expect(recoveryLines()[0]?.textContent).toContain('Revision one recovery')

    const second = getBoard(db, 'alpha', 'Release')!
    expect(advanceBoardRow(db, {
      project: 'alpha',
      title: 'Release',
      label: 'Approve release',
      expectedBoardVersion: second.revision,
      expectedRevision: second.rows[0]!.revision,
      note: 'Third action',
      next_step: 'Choose a third time.',
      action_owner: 'approval',
      impact: 'Still blocks release.',
      context: 'Third action context',
    }).ok).toBe(true)
    await pollTick()

    type(answerInput(rowId), 'Revision three recovery')
    const third = getBoard(db, 'alpha', 'Release')!
    expect(advanceBoardRow(db, {
      project: 'alpha',
      title: 'Release',
      label: 'Approve release',
      expectedBoardVersion: third.revision,
      expectedRevision: third.rows[0]!.revision,
      note: 'Fourth action',
      next_step: 'Choose once more.',
      action_owner: 'approval',
      impact: 'Final release decision.',
      context: 'Fourth action context',
    }).ok).toBe(true)
    click(sendButton(rowId))
    await settle()

    expect(recoveryLines()).toHaveLength(2)
    expect(recoveryLines().map((line) => line.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Revision one recovery'),
      expect.stringContaining('Revision three recovery'),
    ]))
    clearRecovery('Revision three recovery')
    await settle()
    expect(recoveryLines()).toHaveLength(1)
    expect(recoveryLines()[0]?.textContent).toContain('Revision one recovery')
    clearRecovery('Revision one recovery')
    await settle()
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
  })
})
