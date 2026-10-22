// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { upsertBoard } from '../../src/store.js'
import { bootApp, buttonLabelled, click, freshDb, pollTick, settle, useDomTest } from './harness.js'
import { flowPath, openFlow, seedFlow, stepButton } from './plan-flow-fixtures.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

describe('Plan flow milestone', () => {
  it('maps a selected board through explicit row next/outcome edges only', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Public launch',
      rows: [
        {
          label: 'Merge PR #596',
          status: 'blocked',
          note: 'The PR is ready.',
          next_step: 'Choose whether to merge.',
          action_owner: 'approval',
          impact: 'Ships Apple Notes selection.',
          next_after: 'Continue connector rollout.',
        },
        {
          label: 'Spec merged',
          status: 'done',
          note: 'The spec is settled.',
          outcome: 'Implementation dispatched.',
        },
      ],
    })

    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    const board = document.querySelector('#boards .board')!
    click(buttonLabelled('Plan flow', board))
    await settle()

    const mission = document.getElementById('missionbox')!
    expect(mission.hidden).toBe(false)
    expect(mission.querySelector('.mission-root-title')?.textContent).toBe('Public launch')
    expect(mission.querySelectorAll('.mission-path')).toHaveLength(2)
    expect(mission.textContent).toContain('Continue connector rollout.')
    expect(mission.textContent).toContain('Implementation dispatched.')
    expect(mission.querySelector('.mission-result.next')?.textContent).toContain('After this')
    expect(mission.querySelector('.mission-result.outcome')?.textContent).toContain('Outcome')
  })

  it('opens row detail over the flow and only leaves through the explicit Plans action', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Choose tracker',
        status: 'blocked',
        note: 'The outreach kit is ready.',
        next_step: 'Choose the tracker.',
        action_owner: 'decision',
        impact: 'Starts outreach.',
        next_after: 'Send the first three messages.',
      }],
    })

    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(buttonLabelled('Plan flow', document.querySelector('#boards .board')!))
    await settle()
    click(document.querySelector('.mission-node'))
    await settle()

    const mission = document.getElementById('missionbox')!
    expect(mission.hidden).toBe(false)
    expect(mission.querySelector<HTMLElement>('.mission-detail')?.hidden).toBe(false)
    expect(mission.querySelector('.mission-detail-body')?.textContent).toContain('The outreach kit is ready.')

    click(mission.querySelector('.mission-detail-close'))
    await settle()
    expect(mission.hidden).toBe(false)
    expect(mission.querySelector<HTMLElement>('.mission-detail')?.hidden).toBe(true)

    click(document.querySelector('.mission-node'))
    await settle()
    click(mission.querySelector('.mission-detail-board'))
    await settle()
    expect(mission.hidden).toBe(true)
    expect(document.querySelector('#boards .row-panel')?.textContent).toContain('The outreach kit is ready.')
  })
})

// Slice 2 PR E (§9.2): both dependency sources in the flow (fixture in plan-flow-fixtures.ts).
describe('dependencies in Plan flow (slice 2 PR E)', () => {
  it('draws waits-on and unblocks in the agent\'s order, the containment rail, the external issue and the fold', async () => {
    const d = open()
    const { plan, other, id } = seedFlow(d)
    await bootApp(d)
    const box = await openFlow(plan.id)

    expect([...box.querySelectorAll<HTMLElement>('.mission-path')].map((p) => p.dataset.rowId))
      .toEqual(['Build', 'AHP adapter', 'Import requests', 'Control'].map(id))
    const waits = flowPath(id('Import requests')).querySelector('.mission-edge-waits:not(.mission-edge-unblocks)')!
    expect(waits.textContent).toBe('Waits on:Build·AHP adapter (#119)·#130Issue 130Active · copilot · Gateway')
    expect(stepButton(waits, 'Waits on step Build').textContent).toBe('Build')
    expect(stepButton(waits, 'Waits on step AHP adapter (#119)').title).toBe('step in this plan · GitHub')
    expect(flowPath(id('AHP adapter')).querySelector('.mission-edge-unblocks')?.textContent).toBe('Unblocks:Import requests (#120)')
    expect(stepButton(flowPath(id('Build')), 'Unblocks step Import requests (#120)')).toBeTruthy()
    // the external chip is a constructed GitHub link; its activity label names the other plan's row
    const ext = waits.querySelector('.mission-ext a')!
    expect(ext.getAttribute('href')).toBe('https://github.com/shariqh/agent-inbox/issues/130')
    const label = waits.querySelector<HTMLButtonElement>('button[data-issue-open]')!
    expect([label.dataset.issueOpen, label.dataset.issueRow]).toEqual([other.id, other.rows[0]!.id])

    // containment only where the parent is not the plan's issue, never in the waits style
    expect([...box.querySelectorAll('.mission-edge-contains')].map((el) => [el.closest<HTMLElement>('.mission-path')!.dataset.rowId, el.textContent]))
      .toEqual([[id('Control'), 'Part of #200']])
    expect(box.querySelector('.mission-edge-contains.mission-edge-waits, .mission-edge-waits .mission-edge-contains')).toBeNull()
    // next_after stays a result, and creates no edge
    expect(flowPath(id('Import requests')).querySelector('.mission-result.next')?.textContent).toContain('Then ship #131.')
    expect([...box.querySelectorAll('.mission-deps')].map((el) => el.textContent).join('')).not.toContain('#131')
    expect(box.textContent).not.toMatch(/blocked/i)
    expect(box.textContent).not.toContain('Circular')

    const fold = box.querySelector<HTMLDetailsElement>('details.mission-outside')!
    expect(fold.querySelector('summary')?.textContent).toBe('Not in this plan · 1')
    expect(fold.open).toBe(false)
    expect([...fold.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['●#140TelemetryNone here'])
    // the fold stays open across a poll
    fold.open = true
    fold.dispatchEvent(new Event('toggle'))
    await pollTick()
    expect(box.querySelector<HTMLDetailsElement>('details.mission-outside')!.open).toBe(true)
  })

  it('moves focus to the target step and reveals it inside the flow, without opening its detail', async () => {
    const d = open()
    const { plan, id } = seedFlow(d)
    await bootApp(d)
    const box = await openFlow(plan.id)
    // jsdom has no layout: the flow scrolls, and the target sits below its fold
    const paths = box.querySelector<HTMLElement>('.mission-paths')!
    paths.style.overflowY = 'auto'
    Object.defineProperties(paths, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 900 },
    })
    vi.spyOn(paths, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 600, 200))
    const target = flowPath(id('Import requests')).querySelector<HTMLElement>('.mission-node')!
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 500, 300, 90))

    click(stepButton(flowPath(id('AHP adapter')), 'Unblocks step Import requests (#120)'))
    expect(document.activeElement).toBe(buttonLabelled('Open details', flowPath(id('Import requests'))))
    expect(paths.scrollTop).toBe(290)
    expect(box.querySelector<HTMLElement>('.mission-detail')?.hidden).toBe(true)

    click(stepButton(flowPath(id('Import requests')), 'Waits on step Build'))
    expect(document.activeElement).toBe(buttonLabelled('Open details', flowPath(id('Build'))))
  })

  it('opens the other plan\'s row through focusItem from an external activity label, after closing the flow', async () => {
    const d = open()
    const { plan, other } = seedFlow(d)
    await bootApp(d)
    const box = await openFlow(plan.id)
    click(box.querySelector('.mission-edge-waits button[data-issue-open]'))
    await settle()
    expect(box.hidden).toBe(true)
    expect(document.querySelector(`#boards [data-card-id="${other.id}"]`)).not.toBeNull()
    expect(document.querySelector('#boards .row-panel')?.textContent).toContain('The gateway note.')
  })
})
