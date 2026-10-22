// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, upsertBoard } from '../../src/store.js'
import { advanceClock, bootApp, buttonLabelled, click, freshDb, pollTick, settle, useDomTest } from './harness.js'
import { flowPath, openFlow, seedFlow, stepButton } from './plan-flow-fixtures.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

function seed(d: Database.Database) {
  upsertBoard(d, {
    ...AGENT,
    title: 'Launch plan',
    rows: [
      { label: 'Choose tracker', status: 'blocked', note: 'Choose A.' },
      { label: 'Choose channel', status: 'blocked', note: 'Choose B.' },
    ],
  })
  return getBoard(d, AGENT.project, 'Launch plan')!
}

function boardCard(): HTMLElement {
  return document.querySelector('#boards .board')!
}

function mission(): HTMLElement {
  return document.getElementById('missionbox')!
}

function pathFor(label: string): HTMLElement {
  return [...mission().querySelectorAll<HTMLElement>('.mission-path')]
    .find((path) => path.textContent?.includes(label))!
}

describe('Plan Flow focus ownership', () => {
  it('focuses the dialog on open and restores the rebuilt logical opener on close', async () => {
    const d = open()
    const original = seed(d)
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()

    const opener = buttonLabelled('Plan flow', boardCard())!
    opener.focus()
    click(opener)
    await settle()

    expect(document.activeElement).toBe(mission().querySelector('.mission-panel'))

    upsertBoard(d, {
      ...AGENT,
      title: original.title,
      expectedVersion: original.revision,
      rows: original.rows.map((row) => ({
        label: row.label,
        revision: row.revision,
        status: row.status,
        note: `${row.note} refreshed`,
      })),
    })
    await pollTick()

    click(mission().querySelector('.mission-close'))
    expect(opener.isConnected).toBe(false)
    expect(document.activeElement).toBe(buttonLabelled('Plan flow', boardCard()))
  })

  it('restores an identical rebuilt control only within its exact row', async () => {
    const d = open()
    const original = seed(d)
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    const opener = buttonLabelled('Plan flow', boardCard())!
    opener.focus()
    click(opener)
    await settle()

    const before = buttonLabelled('Open details', pathFor('Choose channel'))!
    before.focus()
    upsertBoard(d, {
      ...AGENT,
      title: original.title,
      expectedVersion: original.revision,
      rows: original.rows.map((row) => ({
        label: row.label,
        revision: row.revision,
        status: row.status,
        note: `${row.note} refreshed`,
      })),
    })
    await pollTick()

    const firstRowControl = buttonLabelled('Open details', pathFor('Choose tracker'))
    const exactReplacement = buttonLabelled('Open details', pathFor('Choose channel'))
    expect(before.isConnected).toBe(false)
    expect(document.activeElement).toBe(exactReplacement)
    expect(document.activeElement).not.toBe(firstRowControl)
  })

  it('focuses nested detail, preserves its text control on poll, and returns to its rebuilt row control', async () => {
    const d = open()
    const original = seed(d)
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    const opener = buttonLabelled('Plan flow', boardCard())!
    opener.focus()
    click(opener)
    await settle()

    const rowOpener = buttonLabelled('Open details', pathFor('Choose channel'))!
    rowOpener.focus()
    click(rowOpener)
    await settle()
    expect(document.activeElement).toBe(mission().querySelector('.mission-detail-panel'))

    const input = mission().querySelector<HTMLInputElement>('.mission-detail .reply-input')!
    input.focus()
    const nativeArrow = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(nativeArrow)
    expect(nativeArrow.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(input)

    upsertBoard(d, {
      ...AGENT,
      title: original.title,
      expectedVersion: original.revision,
      rows: original.rows.map((row) => ({
        label: row.label,
        revision: row.revision,
        status: row.status,
        note: `${row.note} refreshed`,
      })),
    })
    await pollTick()

    const replacementInput = mission().querySelector<HTMLInputElement>('.mission-detail .reply-input')!
    expect(input.isConnected).toBe(false)
    expect(document.activeElement).toBe(replacementInput)

    click(mission().querySelector('.mission-detail-close'))
    expect(document.activeElement).toBe(buttonLabelled('Open details', pathFor('Choose channel')))
  })

  it('falls back to the Plan Flow dialog when the focused detail row disappears', async () => {
    const d = open()
    const original = seed(d)
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    const opener = buttonLabelled('Plan flow', boardCard())!
    opener.focus()
    click(opener)
    await settle()

    const rowOpener = buttonLabelled('Open details', pathFor('Choose tracker'))!
    rowOpener.focus()
    click(rowOpener)
    await settle()
    mission().querySelector<HTMLElement>('.mission-detail .reply-input')!.focus()

    const survivor = original.rows[1]!
    upsertBoard(d, {
      ...AGENT,
      title: original.title,
      expectedVersion: original.revision,
      rows: [{
        label: survivor.label,
        revision: survivor.revision,
        status: survivor.status,
        note: survivor.note,
      }],
    })
    await pollTick()

    expect(mission().querySelector<HTMLElement>('.mission-detail')?.hidden).toBe(true)
    expect(document.activeElement).toBe(mission().querySelector('.mission-panel'))
  })
})

// Slice 2 PR E (§9.3): only an explicit activation moves focus to a step. A poll
// restores the flow's focus where it was, and a background window gets none.
describe('Plan flow dependency focus (slice 2 PR E)', () => {
  /** A poll that changes the AHP plan's notes, and so rebuilds every step. */
  function touch(d: Database.Database) {
    const plan = getBoard(d, 'agent-inbox', 'AHP')!
    advanceClock()
    upsertBoard(d, {
      project: 'agent-inbox', agent: 'copilot', stream: 'main', title: 'AHP', repo: 'shariqh/agent-inbox', expectedVersion: plan.revision,
      rows: plan.rows.map((row) => ({ label: row.label, revision: row.revision, status: row.status, note: `${row.note} refreshed` })),
    })
  }

  it('keeps focus on the rebuilt dependency button across a poll, and never moves it to the target or scrolls', async () => {
    const d = open()
    const { plan, id } = seedFlow(d)
    await bootApp(d)
    const box = await openFlow(plan.id)
    const before = stepButton(flowPath(id('Import requests')), 'Waits on step AHP adapter (#119)')
    before.focus()
    const paths = box.querySelector<HTMLElement>('.mission-paths')!
    paths.scrollTop = 40
    touch(d)
    await pollTick()
    const after = stepButton(flowPath(id('Import requests')), 'Waits on step AHP adapter (#119)')
    expect(before.isConnected).toBe(false)
    expect(flowPath(id('Import requests')).textContent).toContain('refreshed')
    expect(document.activeElement).toBe(after)
    expect(paths.scrollTop).toBe(40)

    // an external activity label is restored too
    const label = flowPath(id('Import requests')).querySelector<HTMLButtonElement>('button[data-issue-open]')!
    label.focus()
    touch(d)
    await pollTick()
    expect(document.activeElement).toBe(flowPath(id('Import requests')).querySelector('button[data-issue-open]'))
  })

  it('moves no focus in a background window, while the flow still refreshes', async () => {
    const d = open()
    const { plan, id } = seedFlow(d)
    await bootApp(d)
    await openFlow(plan.id)
    const before = stepButton(flowPath(id('AHP adapter')), 'Unblocks step Import requests (#120)')
    before.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
    before.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    const focused = vi.spyOn(HTMLElement.prototype, 'focus')
    touch(d)
    await pollTick()
    expect(flowPath(id('AHP adapter')).textContent).toContain('refreshed')
    expect(before.isConnected).toBe(false)
    expect(focused).not.toHaveBeenCalled()
    expect(document.activeElement?.tagName).toBe('BODY')
  })
})
