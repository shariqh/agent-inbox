// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(document.querySelector('[data-dashboard-signal="agents"] .dashboard-signal-label')?.textContent).toBe('Reported work')
    expect(document.querySelector('[data-dashboard-signal="agents"]')?.getAttribute('aria-label')).toBe('Agents reporting work: 1 of 1')
    expect(document.querySelector('[data-dashboard-signal="plans"]')?.getAttribute('aria-label')).toBe('Plans: 1 across 1 project')
    expect(document.querySelector('.dashboard-live-session')?.textContent).toContain('Building the dashboard')
    expect(document.querySelector('.dashboard-live-session small')?.textContent).toBe('Reported work')
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
    expect(document.querySelector('.dashboard-live-list .dashboard-empty')?.getAttribute('aria-label')).toBe('No agent connections')
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
      .toBe('Agents reporting work: 6 of 14, including 5 reported child agents')
    expect(document.getElementById('liveStripLabel')?.textContent).toBe('1 reporting work')
  })

  it('renders no lane dots when no agents are present', async () => {
    const d = open()
    await bootApp(d)

    expect(signal('agents')).toBe('0')
    expect(document.querySelector('[data-dashboard-signal="agents"] .dashboard-value-total')?.textContent).toBe('/0')
    expect(agentDots()).toHaveLength(0)
  })

  it('keeps the last work report historical when the connection has no current task', async () => {
    const d = open()
    upsertActivity(d, {
      session: 'quiet', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'Checking the build',
    })
    upsertActivity(d, {
      session: 'quiet', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'open', idle: true,
    })

    await bootApp(d)

    expect(signal('agents')).toBe('0')
    expect(document.querySelector('[data-dashboard-signal="agents"]')?.getAttribute('aria-label'))
      .toBe('Agents reporting work: 0 of 1')
    expect(document.querySelector('.dashboard-live-session small')?.textContent).toBe('Connected')
    expect(document.querySelector('.dashboard-live-session span')?.textContent).toBe('Last report: Checking the build')
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
      .toBe('Agents reporting work: 3 of 4, including 2 reported child agents')
    expect(document.activeElement).toBe(range)
    expect(document.querySelector('.dashboard-range')).toBe(range)
    expect(document.getElementById('pauseHint')?.textContent).toContain('paused')
    expect(document.querySelector('.flow-human strong')?.textContent).toBe('2')
    expect(answerInput(first)?.value).toBe('unfinished answer')
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
    expect(document.querySelector('.dashboard-range')).toBe(range)
  })

  it('refreshes all monitoring detail after choosing 7 days without blurring or replacing the range', async () => {
    const d = open()
    for (let index = 0; index < 5; index += 1) {
      insertItem(d, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question', title: `Decision ${index}` })
    }
    upsertActivity(d, {
      session: 'live', project: 'alpha', stream: 'main', agent: 'copilot',
      doing: 'Running release checks', idle: false,
    })
    advanceClock(60_000)
    await bootApp(d)
    const initial = document.querySelector<HTMLSelectElement>('.dashboard-range')!
    initial.focus()
    initial.value = String(7 * 24 * 60 * 60 * 1000)
    initial.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    const range = document.querySelector<HTMLSelectElement>('.dashboard-range')!
    expect(signal('waiting')).toBe('5')
    expect(signal('agents')).toBe('1')
    expect(document.querySelector('.dashboard-activity-total strong')?.textContent).toBe('1m')

    advanceClock(60_000)
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question', title: 'New decision' })
    upsertActivity(d, {
      session: 'live', project: 'alpha', stream: 'main', agent: 'copilot',
      doing: 'open', idle: true,
    })
    const outcome = insertItem(d, {
      project: 'alpha', stream: 'main', agent: 'copilot', kind: 'done', title: 'Verification finished',
    })
    resolveItem(d, outcome, 'Checks completed.')
    await pollTick()

    expect(signal('waiting')).toBe('6')
    expect(signal('agents')).toBe('0')
    expect(document.querySelector('.flow-human strong')?.textContent).toBe('6')
    expect(document.querySelector('.flow-outcome strong')?.textContent).toBe('1')
    expect(document.querySelector('.dashboard-live-session small')?.textContent).toBe('Connected')
    expect(document.querySelector('.dashboard-live-session span')?.textContent).toBe('Last report: Running release checks')
    expect(document.querySelector('.dashboard-outcome')?.textContent).toContain('Checks completed.')
    expect(document.querySelector('.dashboard-activity-total strong')?.textContent).toBe('2m')
    expect(document.querySelectorAll('.dashboard-bar')).toHaveLength(14)
    expect(document.querySelector('.dashboard-range')).toBe(range)
    expect(range.value).toBe(String(7 * 24 * 60 * 60 * 1000))
    expect(document.activeElement).toBe(range)
    expect(document.getElementById('pauseHint')?.textContent).toBe('')
  })

  it('refreshes history error and recovery while the native range keeps ownership', async () => {
    const d = open()
    upsertActivity(d, {
      session: 'live', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'Working',
    })
    advanceClock(60_000)
    let failHistory = false
    await bootApp(d, {
      interceptFetch: async (input, _init, next) => failHistory && String(input).startsWith('/api/activity/history')
        ? new Response('unavailable', { status: 503 })
        : next(),
    })
    const range = document.querySelector<HTMLSelectElement>('.dashboard-range')!
    range.focus()
    failHistory = true
    await pollTick()
    expect(document.querySelector('.dashboard-history-error')?.textContent).toBe('History unavailable')
    expect(document.querySelector('.dashboard-bars')).toBeNull()
    expect(document.querySelector('.dashboard-range')).toBe(range)
    expect(document.activeElement).toBe(range)

    failHistory = false
    await pollTick()
    expect(document.querySelector('.dashboard-history-error')).toBeNull()
    expect(document.querySelector('.dashboard-bars')).not.toBeNull()
    expect(document.querySelector('.dashboard-range')).toBe(range)
    expect(document.activeElement).toBe(range)
  })

  it('keeps a focused outcome button while updating its text and surrounding recent results', async () => {
    const d = open()
    const first = insertItem(d, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'done', title: 'First result' })
    resolveItem(d, first, 'Original result.')
    advanceClock()
    const second = insertItem(d, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'done', title: 'Second result' })
    resolveItem(d, second, 'Second result recorded.')
    await bootApp(d)
    const focused = document.querySelector<HTMLButtonElement>(`[data-dashboard-focus-key="outcome:${first}"]`)!
    focused.focus()

    advanceClock()
    resolveItem(d, first, 'Updated result.')
    await pollTick()
    expect(document.querySelector(`[data-dashboard-focus-key="outcome:${first}"]`)).toBe(focused)
    expect(focused.textContent).toContain('Updated result.')
    expect(document.querySelector('.dashboard-outcome')).toBe(focused)
    expect(document.activeElement).toBe(focused)
    click(focused)
    await settle()
    expect(document.getElementById('done')?.hidden).toBe(false)
    expect(document.querySelector<HTMLDetailsElement>(`#done [data-card-id="${first}"]`)?.open).toBe(true)
    expect(document.querySelector(`#done [data-card-id="${first}"]`)?.textContent).toContain('Updated result.')
  })

  it.each([true, false])('handles a result leaving the recent list without stealing background focus (owns focus: %s)', async (ownsFocus) => {
    const d = open()
    const old = insertItem(d, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'done', title: 'Old result' })
    resolveItem(d, old, 'Old outcome.')
    await bootApp(d)
    const focused = document.querySelector<HTMLButtonElement>('.dashboard-outcome')!
    focused.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(ownsFocus)
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    for (let index = 0; index < 5; index += 1) {
      advanceClock()
      const id = insertItem(d, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'done', title: `New result ${index}` })
      resolveItem(d, id, `New outcome ${index}.`)
    }
    await pollTick()
    expect(focused.isConnected).toBe(false)
    expect(document.querySelectorAll('.dashboard-outcome')).toHaveLength(4)
    if (ownsFocus) expect(document.activeElement?.matches('.dashboard-outcome')).toBe(true)
    else expect(focus).not.toHaveBeenCalled()
  })

  it('keeps Dashboard detail scoped while the title badge remains global', async () => {
    const d = open()
    for (const project of ['alpha', 'beta']) {
      insertItem(d, { project, stream: 'main', agent: 'copilot', kind: 'question', title: `${project} decision` })
      upsertActivity(d, { session: project, project, stream: 'main', agent: 'copilot', doing: `${project} work` })
    }
    await bootApp(d)
    click(document.querySelector('#rail .rail-tab[data-project="alpha"]'))
    await settle()
    const range = document.querySelector<HTMLSelectElement>('.dashboard-range')!
    range.focus()
    for (const project of ['alpha', 'beta']) {
      insertItem(d, { project, stream: 'main', agent: 'copilot', kind: 'question', title: `New ${project} decision` })
    }
    await pollTick()
    expect(document.title).toBe('(4) Agent Inbox')
    expect(signal('waiting')).toBe('2')
    expect(document.querySelector('.flow-human strong')?.textContent).toBe('2')
    expect(document.querySelectorAll('.dashboard-live-session')).toHaveLength(1)
    expect(document.querySelector('.dashboard-live-session strong')?.textContent).toContain('alpha')
    expect(document.activeElement).toBe(range)
  })

  it('holds Dashboard detail through a pointer press, then refreshes without a false pause notice', async () => {
    const d = open()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question', title: 'First decision' })
    await bootApp(d)
    const range = document.querySelector<HTMLSelectElement>('.dashboard-range')!
    range.focus()
    await vi.advanceTimersByTimeAsync(2800)
    range.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question', title: 'Next decision' })
    await vi.advanceTimersByTimeAsync(200)
    expect(signal('waiting')).toBe('1')
    expect(document.querySelector('.flow-human strong')?.textContent).toBe('1')
    expect(document.getElementById('pauseHint')?.textContent).toBe('')
    range.dispatchEvent(new Event('pointerup', { bubbles: true }))
    await pollTick()
    expect(signal('waiting')).toBe('2')
    expect(document.querySelector('.flow-human strong')?.textContent).toBe('2')
    expect(document.querySelector('.dashboard-range')).toBe(range)
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
