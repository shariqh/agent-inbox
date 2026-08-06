// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, insertItem, listItems, openDb, updateBoardRow, upsertBoard } from '../../src/store.js'
import {
  answerInput, badgeCount, bootApp, buttonLabelled, click, freshDb, row, rowTitles,
  pollTick, sendButton, settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

function chipText(id: string): string {
  const chip = row(id)?.querySelector('.chip')
  return [...(chip?.childNodes ?? [])]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? '')
    .join('')
    .trim()
}

describe('human disposition controls', () => {
  it('snoozes an item into a visible fold and can wake it immediately', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Merge?',
      detail: 'All gates are green.',
      next_step: 'Choose whether to merge.',
      action_owner: 'approval',
      impact: 'Unblocks implementation.',
      options: [{ label: 'Merge', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(d)
    expect(badgeCount()).toBe(1)

    click(row(id))
    await settle()
    click(buttonLabelled('Not now · 4h', row(id)!))
    await settle()

    expect(badgeCount()).toBe(0)
    expect(rowTitles()).toContain('Merge?')
    expect(chipText(id)).toMatch(/^snoozed /)
    expect(document.querySelector('.snoozed-fold')?.textContent).toContain('Merge?')

    click(buttonLabelled('Wake now', row(id)!))
    await settle()
    expect(badgeCount()).toBe(1)
    expect(chipText(id)).not.toMatch(/^snoozed /)
  })

  it('requests clarification on a row without pretending the work is complete', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Recruit partners',
        status: 'blocked',
        note: 'The outreach kit is ready.',
        next_step: 'Choose the tracker.',
        action_owner: 'decision',
        impact: 'Required before outreach starts.',
        options: [{ label: 'People Pipeline', recommended: true }, { label: 'Scratchpad' }],
      }],
    })
    const rowId = getBoard(d, 'alpha', 'Launch')!.rows[0]!.id
    await bootApp(d)
    click(row(rowId))
    await settle()
    click(buttonLabelled('Needs clarification', row(rowId)!))
    await settle()

    expect(badgeCount()).toBe(0)
    const stored = getBoard(d, 'alpha', 'Launch')!.rows[0]!
    expect(stored.annotation_kind).toBe('clarify')
    expect(stored.status).toBe('blocked')
    expect(rowTitles()).toContain('Recruit partners')
    expect(row(rowId)?.textContent).toContain('Waiting for the agent')
  })

  it('records decline as a distinct response kind', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Publish today?',
      detail: 'The build is ready.',
      next_step: 'Choose whether to publish.',
      action_owner: 'approval',
      impact: 'Makes the release public.',
      options: [{ label: 'Publish', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(d)
    click(row(id))
    await settle()
    click(buttonLabelled('Decline', row(id)!))
    await settle()

    expect(listItems(d)[0]).toMatchObject({ reply: 'Declined', reply_kind: 'decline' })
    expect(badgeCount()).toBe(0)
  })

  it('preserves a response rejected because the action changed before Send', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{ label: 'Deploy', status: 'blocked', note: 'Choose a window.' }],
    })
    const original = getBoard(d, 'alpha', 'Launch')!
    const rowId = original.rows[0]!.id
    await bootApp(d)
    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'Tomorrow morning')

    updateBoardRow(d, {
      ...AGENT,
      title: 'Launch',
      label: 'Deploy',
      expectedBoardVersion: original.revision,
      expectedRevision: original.rows[0]!.revision,
      note: 'Choose a window after the hotfix.',
    })
    click(sendButton(rowId))
    await settle()

    expect(getBoard(d, 'alpha', 'Launch')!.rows[0]!.annotation).toBeNull()
    expect(row(rowId)?.textContent).toContain('Preserved answer: Tomorrow morning')

    const current = getBoard(d, 'alpha', 'Launch')!
    updateBoardRow(d, {
      ...AGENT,
      title: 'Launch',
      label: 'Deploy',
      expectedBoardVersion: current.revision,
      expectedRevision: current.rows[0]!.revision,
      status: 'done',
      outcome: 'Action superseded.',
    })
    await pollTick()
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Tomorrow morning')
  })

  it('preserves the response kind when clarification loses a revision race', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{ label: 'Deploy', status: 'blocked', note: 'Choose a window.' }],
    })
    const original = getBoard(d, 'alpha', 'Launch')!
    const rowId = original.rows[0]!.id
    await bootApp(d)
    click(row(rowId))
    await settle()

    updateBoardRow(d, {
      ...AGENT,
      title: 'Launch',
      label: 'Other rollout step',
      expectedBoardVersion: original.revision,
      status: 'tracked',
      note: 'Concurrent board change.',
    })
    click(buttonLabelled('Needs clarification', row(rowId)!))
    await settle()

    expect(answerInput(rowId)?.value).toContain('Please clarify')
    click(row(rowId))
    await settle()
    click(row(rowId))
    await settle()
    click(sendButton(rowId))
    await settle()
    expect(getBoard(d, 'alpha', 'Launch')!.rows.find((candidate) => candidate.id === rowId))
      .toMatchObject({ annotation_kind: 'clarify' })
  })
})
