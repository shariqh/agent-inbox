// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { upsertBoard } from '../../src/store.js'
import { bootApp, buttonLabelled, click, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

describe('Mission Map milestone', () => {
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
    click(buttonLabelled('Map', board))
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

  it('opens row detail over the map and only leaves through the explicit Boards action', async () => {
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
    click(buttonLabelled('Map', document.querySelector('#boards .board')!))
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
