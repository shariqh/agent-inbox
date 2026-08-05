// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import {
  advanceBoardRow,
  annotateBoardRow,
  getBoard,
  insertItem,
  listBoards,
  markAnnotationDelivered,
  updateBoardRow,
  upsertBoard,
} from '../../src/store.js'
import {
  advanceClock, bootApp, buttonLabelled, click, freshDb, row, rowTitles, settle, useDomTest,
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

describe('action lifecycle presentation', () => {
  it('shows ownership and filters the queue by Decisions, Tasks, and New/changed', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Upload notarized build',
        status: 'blocked',
        note: 'The signed artifact is ready.',
        next_step: 'Upload the build.',
        action_owner: 'task',
        impact: 'Required for release.',
      }],
    })
    const taskId = getBoard(d, 'alpha', 'Launch')!.rows[0]!.id
    advanceClock()
    localStorage.setItem('agent-inbox-last-visit', new Date().toISOString())
    advanceClock()
    const beforeUpdate = getBoard(d, 'alpha', 'Launch')!
    updateBoardRow(d, {
      ...AGENT,
      title: 'Launch',
      label: 'Upload notarized build',
      expectedBoardVersion: beforeUpdate.revision,
      expectedRevision: beforeUpdate.rows[0]!.revision,
      note: 'The signed and notarized artifact is ready.',
    })
    advanceClock()
    const decisionId = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Publish?',
      detail: 'The build is ready.',
      next_step: 'Choose whether to publish.',
      action_owner: 'approval',
      impact: 'Makes the release public.',
      next_after: 'The agent publishes the release.',
      options: [{ label: 'Publish', recommended: true }, { label: 'Hold' }],
    })

    await bootApp(d)
    expect(row(taskId)?.textContent).toContain('You do')
    expect(row(taskId)?.textContent).toContain('changed')
    expect(row(decisionId)?.textContent).toContain('Agent acts after approval')
    expect(row(decisionId)?.textContent).toContain('new')

    click(buttonLabelled('Decisions'))
    await settle()
    expect(rowTitles()).toEqual(['Publish?'])

    click(buttonLabelled('Tasks'))
    await settle()
    expect(rowTitles()).toEqual(['Upload notarized build'])

    click(buttonLabelled('All'))
    click(buttonLabelled('New / changed'))
    await settle()
    expect(new Set(rowTitles())).toEqual(new Set(['Publish?', 'Upload notarized build']))
  })

  it('shows impact, next-after, lifecycle history, and outcomes without expanding background', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Outreach',
        status: 'blocked',
        note: 'The kit is ready.',
        next_step: 'Choose the tracker.',
        action_owner: 'decision',
        impact: 'Required before outreach starts.',
        next_after: 'Send the first three messages.',
        options: [{ label: 'People Pipeline', recommended: true }, { label: 'Scratchpad' }],
      }],
    })
    let board = getBoard(d, 'alpha', 'Launch')!
    let current = board.rows[0]!
    annotateBoardRow(d, current.id, 'People Pipeline')
    board = getBoard(d, 'alpha', 'Launch')!
    current = board.rows[0]!
    advanceBoardRow(d, {
      project: 'alpha',
      title: 'Launch',
      label: 'Outreach',
      expectedBoardVersion: board.revision,
      expectedRevision: current.revision,
      note: 'The tracker is selected.',
      next_step: 'Send the first three personalized messages.',
      action_owner: 'task',
      impact: 'Starts the design-partner evidence loop.',
      next_after: 'Review replies and schedule interviews.',
    })
    current = getBoard(d, 'alpha', 'Launch')!.rows[0]!

    await bootApp(d)
    click(row(current.id))
    await settle()
    const card = row(current.id)?.querySelector('.nrow-card')
    expect(card?.textContent).toContain('You do')
    expect(card?.textContent).toContain('Starts the design-partner evidence loop.')
    expect(card?.textContent).toContain('Review replies and schedule interviews.')
    expect(card?.querySelector('.action-history')?.textContent).toContain('People Pipeline')
  })

  it('flags answered work that an agent picked up but has not finished', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Merge',
        status: 'blocked',
        note: 'All gates are green.',
        next_step: 'Choose whether to merge.',
        action_owner: 'approval',
        impact: 'Unblocks implementation.',
        options: [{ label: 'Merge', recommended: true }, { label: 'Hold' }],
      }],
    })
    const board = listBoards(d)[0]!
    const rowId = board.rows[0]!.id
    advanceClock()
    annotateBoardRow(d, rowId, 'Merge')
    markAnnotationDelivered(d, rowId, getBoard(d, 'alpha', 'Launch')!.rows[0]!.annotated_at, 'claude-code')
    advanceClock(2 * 60 * 60_000)

    await bootApp(d)
    expect(chipText(rowId)).toBe('agent overdue 2h')
    click(row(rowId))
    await settle()
    expect(row(rowId)?.textContent).toContain('Agent picked up')
  })
})
