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

const agentDots = (): Element[] =>
  [...document.querySelectorAll('[data-dashboard-signal="agents"] .dashboard-agent-dot')]

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
    expect(document.querySelector('[data-dashboard-signal="agents"] .dashboard-value-total')?.textContent).toBe('/1')
    expect(document.querySelector('[data-dashboard-signal="plans"]')?.getAttribute('aria-label')).toBe('Plans: 1 across 1 project')
    expect(document.querySelector('.dashboard-live-session')?.textContent).toContain('Building the dashboard')
    expect(document.querySelector('.dashboard-outcome')?.textContent).toContain('Package verified.')
    expect(document.querySelector('.dashboard-bars')).not.toBeNull()
  })

  it('uses visuals instead of explanatory dashboard subtext', async () => {
    const d = open()
    await bootApp(d)

    expect(document.querySelector('.dashboard-summary')).toBeNull()
    expect(document.querySelector('.dashboard-signal-detail')).toBeNull()
    expect(document.querySelector('.dashboard-card-head p')).toBeNull()
    expect(document.querySelector('.dashboard-history-empty')?.getAttribute('aria-label')).toBe('No activity history yet')
    expect(document.querySelector('.dashboard-history-empty')?.getAttribute('role')).toBe('img')
    expect(document.querySelector('.dashboard-history-empty')?.getAttribute('title')).toBe('No activity history yet')
    expect(document.querySelector('.dashboard-history-empty .dashboard-empty-icon')).not.toBeNull()
    expect(document.querySelector('.dashboard-history-empty')?.textContent?.trim()).toBe('')
    expect(document.querySelectorAll('.dashboard-signal-icon')).toHaveLength(4)
  })

  it('renders one decorative lane dot per present top-level agent', async () => {
    const d = open()
    for (let index = 0; index < 2; index += 1) {
      upsertActivity(d, {
        session: `working-${index}`,
        project: 'alpha',
        stream: 'main',
        agent: 'copilot',
        doing: 'Working',
        idle: false,
      })
    }
    for (let index = 0; index < 8; index += 1) {
      upsertActivity(d, {
        session: `quiet-${index}`,
        project: 'alpha',
        stream: 'main',
        agent: 'copilot',
        doing: 'open',
        idle: true,
      })
    }

    await bootApp(d)

    expect(signal('agents')).toBe('2')
    expect(document.querySelector('[data-dashboard-signal="agents"] .dashboard-value-total')?.textContent).toBe('/10')
    expect(agentDots()).toHaveLength(10)
    expect(agentDots().filter((dot) => dot.classList.contains('active'))).toHaveLength(2)
    expect(agentDots().filter((dot) => dot.classList.contains('quiet'))).toHaveLength(8)
    expect(document.querySelector('.dashboard-agent-dots')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('expands the active fraction for reported child lanes and describes the contribution', async () => {
    const d = open()
    upsertActivity(d, {
      session: 'manager',
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      doing: 'Coordinating',
      idle: false,
      children: Array.from({ length: 5 }, (_, index) => ({
        name: `worker-${index}`,
        doing: 'Working',
      })),
    })
    for (let index = 0; index < 8; index += 1) {
      upsertActivity(d, {
        session: `quiet-${index}`,
        project: 'alpha',
        stream: 'main',
        agent: 'copilot',
        doing: 'open',
        idle: true,
        children: [{ name: 'stale-child', doing: 'Ignored' }],
      })
    }

    await bootApp(d)

    expect(signal('agents')).toBe('6')
    expect(document.querySelector('[data-dashboard-signal="agents"] .dashboard-value-total')?.textContent).toBe('/14')
    expect(agentDots()).toHaveLength(14)
    expect(agentDots().filter((dot) => dot.classList.contains('active'))).toHaveLength(6)
    expect(agentDots().filter((dot) => dot.classList.contains('quiet'))).toHaveLength(8)
    expect(document.querySelector('[data-dashboard-signal="agents"]')?.getAttribute('aria-label'))
      .toBe('Active agents: 6 of 14 present, including 5 reported child agents')
    expect(document.getElementById('liveStripLabel')?.textContent).toBe('1 working')
  })

  it('renders no lane dots when no agents are present', async () => {
    const d = open()
    await bootApp(d)

    expect(signal('agents')).toBe('0')
    expect(document.querySelector('[data-dashboard-signal="agents"] .dashboard-value-total')?.textContent).toBe('/0')
    expect(agentDots()).toHaveLength(0)
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
    upsertActivity(d, {
      session: 'manager',
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      doing: 'Coordinating',
      idle: false,
    })
    upsertActivity(d, {
      session: 'quiet',
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      doing: 'open',
      idle: true,
    })
    await bootApp(d)

    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    click(row(first))
    await settle()
    type(answerInput(first), 'unfinished answer')
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    const range = document.querySelector<HTMLSelectElement>('.dashboard-range')!
    range.focus()

    advanceClock()
    insertItem(d, {
      project: 'beta',
      stream: 'main',
      agent: 'claude',
      kind: 'question',
      title: 'Second decision',
    })
    upsertActivity(d, {
      session: 'manager',
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      doing: 'Coordinating',
      idle: false,
      children: [
        { name: 'worker-a', doing: 'Testing' },
        { name: 'worker-b', doing: 'Reviewing' },
      ],
    })
    await pollTick()

    expect(signal('waiting')).toBe('2')
    expect(signal('agents')).toBe('3')
    expect(document.querySelector('[data-dashboard-signal="agents"] .dashboard-value-total')?.textContent).toBe('/4')
    expect(agentDots()).toHaveLength(4)
    expect(agentDots().filter((dot) => dot.classList.contains('active'))).toHaveLength(3)
    expect(agentDots().filter((dot) => dot.classList.contains('quiet'))).toHaveLength(1)
    expect(document.querySelector('[data-dashboard-signal="agents"]')?.getAttribute('aria-label'))
      .toBe('Active agents: 3 of 4 present, including 2 reported child agents')
    expect(document.activeElement).toBe(range)
    expect(document.querySelector('.dashboard-range')).toBe(range)
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
    expect(document.querySelector('[data-dashboard-signal="waiting"]')?.getAttribute('aria-label')).toBe('Needs you: 1 open action')
  })
})
