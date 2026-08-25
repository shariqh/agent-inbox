// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import {
  archiveBoard, closeProject, getBoard, insertItem, resolveItem, upsertActivity, upsertBoard,
} from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, click, freshDb, pollTick, row, settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const signal = (name: string): string =>
  document.querySelector(`[data-dashboard-signal="${name}"] .dashboard-value`)?.textContent ?? ''

describe('Live Operations Desk dashboard', () => {
  it('is the default view and projects real current state', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Approve release',
    })
    advanceClock()
    const finished = insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Verify package',
    })
    resolveItem(d, finished, 'Package verified.')
    upsertBoard(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      title: 'Release plan',
      rows: [{ label: 'Build', status: 'tracked' }],
    })
    upsertActivity(d, {
      session: 'live',
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      doing: 'Building the dashboard',
      idle: false,
    })
    advanceClock(60_000)

    await bootApp(d)

    expect(document.querySelector('.tab[data-tab="dashboard"]')?.getAttribute('aria-selected')).toBe('true')
    expect(document.getElementById('dashboard')?.hidden).toBe(false)
    expect(document.getElementById('pageTitle')?.textContent).toBe('Live Operations Desk')
    expect(signal('agents')).toBe('1')
    expect(signal('waiting')).toBe('1')
    expect(signal('plans')).toBe('1')
    expect(signal('outcomes')).toBe('1')
    expect(document.querySelector('.dashboard-live-session')?.textContent).toContain('Building the dashboard')
    expect(document.querySelector('.dashboard-outcome')?.textContent).toContain('Package verified.')
    expect(document.querySelector('.dashboard-bars')).not.toBeNull()
  })

  it('drills from the waiting signal into the existing Inbox queue', async () => {
    const d = open()
    const id = insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Choose release window',
    })

    await bootApp(d)
    click(document.querySelector('[data-dashboard-target="needsYou"]'))
    await settle()

    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(document.querySelector('.tab[data-tab="needsYou"]')?.getAttribute('aria-selected')).toBe('true')
    expect(row(id)).not.toBeNull()
  })

  it('opens the complete outcomes projection and reaches an archived plan outcome', async () => {
    const d = open()
    upsertBoard(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      title: 'Archived rollout',
      rows: [{
        label: 'Canary complete',
        status: 'tracked',
        outcome: 'Canary reached 100%.',
      }],
    })
    const board = getBoard(d, 'alpha', 'Archived rollout')!
    expect(archiveBoard(d, board.id, board.revision)).toBe(true)
    await bootApp(d)

    click(document.querySelector('[data-dashboard-target="outcomes"]'))
    await settle()
    expect(document.getElementById('relaybox')?.hidden).toBe(false)
    expect(document.querySelector('[data-relay-lane="outcome"]')?.textContent).toContain('Canary reached 100%.')

    click(document.querySelector('[data-relay-lane="outcome"] .relay-open'))
    await settle()
    expect(document.getElementById('boards')?.hidden).toBe(false)
    expect(document.querySelector<HTMLDetailsElement>('#boards .archived-fold')?.open).toBe(true)
    expect(document.querySelector(`[data-card-id="${board.id}"]`)).not.toBeNull()
  })

  it('keeps ambient dashboard counts reactive while a draft defers editable rendering', async () => {
    const d = open()
    const first = insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'First decision',
    })
    await bootApp(d)

    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    click(row(first))
    await settle()
    type(answerInput(first), 'unfinished answer')
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()

    advanceClock()
    insertItem(d, {
      project: 'beta',
      stream: 'main',
      agent: 'claude',
      kind: 'question',
      title: 'Second decision',
    })
    await pollTick()

    expect(signal('waiting')).toBe('2')
    expect(document.getElementById('pauseHint')?.textContent).toContain('paused')
  })

  it('does not replace a focused dashboard control during polling', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Keep dashboard focus',
    })
    await bootApp(d)

    const range = document.querySelector<HTMLSelectElement>('.dashboard-range')!
    range.focus()
    await pollTick()
    expect(document.activeElement).toBe(range)
    expect(document.querySelector('.dashboard-range')).toBe(range)

    range.value = String(7 * 24 * 60 * 60 * 1000)
    range.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect((document.activeElement as HTMLElement)?.dataset.dashboardFocusKey).toBe('activity-range')
  })

  it('shows an explicitly selected closed project as a deliberate dashboard peek', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Muted decision',
    })
    closeProject(d, 'alpha')
    await bootApp(d)
    expect(signal('waiting')).toBe('0')

    click(document.querySelector('#rail .closed-fold > summary'))
    click(document.querySelector('#rail .closed-fold .rail-tab[data-project="alpha"]'))
    await settle()

    expect(signal('waiting')).toBe('1')
    expect(document.querySelector('.dashboard-summary')?.textContent).toContain('1 project')
  })
})
