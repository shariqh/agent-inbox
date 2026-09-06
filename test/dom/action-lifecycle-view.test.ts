// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import {
  advanceBoardRow,
  annotateBoardRow,
  getBoard,
  getItem,
  insertItem,
  listBoards,
  markAnnotationDelivered,
  markReplySeen,
  replyItem,
  resolveItem,
  updateBoardRow,
  upsertBoard,
} from '../../src/store.js'
import {
  advanceClock, badgeCount, bootApp, buttonLabelled, click, freshDb, pollTick, row, rowTitles, settle, useDomTest,
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
  it('shows ownership and filters the queue by Decisions, To do, and Updates', async () => {
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
    expect(row(taskId)?.textContent).toContain('To do')
    expect(row(taskId)?.textContent).toContain('changed')
    expect(row(decisionId)?.textContent).toContain('Ready after approval')
    expect(row(decisionId)?.textContent).toContain('new')

    click(buttonLabelled('Decisions'))
    await settle()
    expect(rowTitles()).toEqual(['Choose whether to publish.'])

    click(buttonLabelled('To do'))
    await settle()
    expect(rowTitles()).toEqual(['Upload the build.'])

    click(buttonLabelled('All'))
    click(buttonLabelled('Updates'))
    await settle()
    expect(new Set(rowTitles())).toEqual(new Set(['Choose whether to publish.', 'Upload the build.']))
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
    expect(card?.textContent).toContain('To do')
    expect(card?.textContent).toContain('Starts the design-partner evidence loop.')
    expect(card?.textContent).toContain('Review replies and schedule interviews.')
    expect(card?.querySelector('.action-history')?.textContent).toContain('People Pipeline')
    for (const selector of ['.card-context', '.action-history']) {
      const disclosure = card?.querySelector<HTMLDetailsElement>(selector)
      disclosure!.open = true
      disclosure!.dispatchEvent(new window.Event('toggle'))
    }
    await pollTick()
    expect(row(current.id)?.querySelector<HTMLDetailsElement>('.card-context')?.open).toBe(true)
    expect(row(current.id)?.querySelector<HTMLDetailsElement>('.action-history')?.open).toBe(true)
  })

  it('flags a delivered response with no recorded result, without claiming the asking agent resumed', async () => {
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
    expect(chipText(rowId)).toBe('follow-up due 2h')
    click(row(rowId))
    await settle()
    expect(row(rowId)?.textContent).toContain('Delivered to claude-code')
    expect(row(rowId)?.querySelector('.lifecycle-receipt')?.textContent).toContain('Delivered to an agent')
    expect(row(rowId)?.querySelector('.outcome-block')).toBeNull()
  })

  it('distinguishes an unanswered request, a saved response, delivery, and a recorded result', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Publish the release?',
      detail: 'The release is ready.',
      next_step: 'Choose whether to publish.',
      options: [{ label: 'Publish', recommended: true }, { label: 'Hold' }],
    })

    await bootApp(d)
    expect(badgeCount()).toBe(1)
    click(row(id))
    await settle()
    expect(row(id)?.querySelector('.pickup')).toBeNull()
    expect(row(id)?.querySelector('.opt-pill.rec')?.textContent).toContain('Publish')

    advanceClock()
    replyItem(d, id, 'Publish')
    await pollTick()
    expect(row(id)?.querySelector('.pickup.awaiting')?.textContent).toBe('Saved · waiting for delivery')
    expect(row(id)?.querySelector('.outcome-block')).toBeNull()
    expect(badgeCount()).toBe(0)

    advanceClock()
    markReplySeen(d, id, getItem(d, id)!.replied_at)
    await pollTick()
    expect(row(id)?.querySelector('.pickup.picked')?.textContent).toBe('Delivered to an agent')
    expect(row(id)?.querySelector('.pickup.picked')?.getAttribute('title'))
      .toBe('Delivery does not confirm the asking agent has resumed.')
    expect(row(id)?.querySelector('.outcome-block')).toBeNull()
    expect(getItem(d, id)?.status).toBe('open')
    expect(badgeCount()).toBe(0)

    advanceClock()
    resolveItem(d, id, 'Release published.')
    await pollTick()
    click(document.querySelector('.tab[data-tab="done"]'))
    await settle()
    const result = document.querySelector(`[data-card-id="${id}"]`)
    expect(result?.textContent).toContain('Release published.')
    expect(result?.querySelector('.outcome-block')?.textContent).toContain('Release published.')
  })
})
