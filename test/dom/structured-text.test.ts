// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listBoards, replyItem, resolveItem, upsertBoard } from '../../src/store.js'
import {
  bootApp, buttonLabelled, click, freshDb, row, settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

function expectSafeLink(link: HTMLAnchorElement | null, href: string): void {
  expect(link?.href).toBe(href)
  expect(link?.target).toBe('_blank')
  expect(link?.rel).toBe('noopener noreferrer')
}

describe('structured agent text on cards and plans', () => {
  it('renders item paragraphs/lists/links and preserves collapsed Background state', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Review rollout',
      detail: 'Ready for review.\n\n- Check CI\n- Read https://example.com/review.',
      next_step: 'Choose a path at https://example.com/decision.',
      context: 'History:\n\n1. Drafted\n2. Reviewed\n\n<script>alert(1)</script>',
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const card = row(id)?.querySelector('.nrow-card')
    expect(card?.querySelectorAll('.card-tldr .structured-text p')).toHaveLength(1)
    expect(card?.querySelectorAll('.card-tldr .structured-text li')).toHaveLength(2)
    expect(card?.querySelector('.card-tldr')?.textContent).toContain('Check CI')
    expect(card?.querySelector('script')).toBeNull()
    expect(card?.querySelector('.card-context')?.hasAttribute('open')).toBe(false)
    expect(card?.querySelectorAll('.card-context li')).toHaveLength(2)
    expectSafeLink(
      card?.querySelector<HTMLAnchorElement>('.card-next .structured-link') ?? null,
      'https://example.com/decision',
    )
  })

  it('leaves human-authored replies and reply context on their existing plain-text path', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Choose?',
      detail: 'Agent-authored https://example.com/agent',
    })
    replyItem(
      d,
      id,
      'Human reply:\n- not a list\nhttps://example.com/human',
      'Human context: https://example.com/context',
    )

    await bootApp(d)
    click(row(id))
    await settle()

    const reply = row(id)?.querySelector('.reply-block')
    expect(reply?.textContent).toContain('- not a list')
    expect(reply?.querySelector('.structured-text')).toBeNull()
    expect(reply?.querySelector('a')).toBeNull()
    expect(reply?.querySelector('li')).toBeNull()
  })

  it('uses the same renderer for board row summaries, context, and outcomes', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch plan',
      rows: [{
        label: 'Publish',
        status: 'tracked',
        note: 'Release notes:\n\n- API\n- UI',
        context: 'Evidence at https://example.com/evidence.\n\nSecond paragraph.',
        outcome: 'Published safely.\n\n1. Canary\n2. Production',
      }],
    })

    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector('#boards .board-row'))
    await settle()

    const panel = document.querySelector('#boards .row-panel')
    expect(panel?.querySelectorAll('.card-tldr li')).toHaveLength(2)
    expect(panel?.querySelectorAll('.outcome-block li')).toHaveLength(2)
    expect(panel?.querySelector('.card-context')?.hasAttribute('open')).toBe(false)
    expectSafeLink(
      panel?.querySelector<HTMLAnchorElement>('.card-context .structured-link') ?? null,
      'https://example.com/evidence',
    )
  })
})

describe('structured agent text on outcome, relay, and mission projections', () => {
  it('renders completed outcomes in both receipts and relay cards', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Ship?',
      detail: 'Canary report:\n\n- healthy\n- stable',
      action_owner: 'approval',
    })
    resolveItem(d, id, 'Shipped.\n\n- Notes: https://example.com/release.\n- No rollback.')

    await bootApp(d)
    click(document.querySelector('.tab[data-tab="done"]'))
    await settle()
    click(document.querySelector(`[data-card-id="${id}"]`))
    await settle()

    const doneCard = document.querySelector(`[data-card-id="${id}"] .card`)
    expect(doneCard?.querySelectorAll('.outcome-block li')).toHaveLength(2)
    expect(doneCard?.querySelectorAll('.lifecycle-step li')).toHaveLength(2)

    click(document.querySelector('.relay-btn'))
    await settle()
    const relay = document.querySelector('[data-relay-lane="outcome"] .relay-card')
    expect(relay?.querySelectorAll('.relay-result li')).toHaveLength(2)
    expectSafeLink(
      relay?.querySelector<HTMLAnchorElement>('.relay-result .structured-link') ?? null,
      'https://example.com/release',
    )
  })

  it('renders plan summaries and explicit outcomes in the mission map', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Mission',
      rows: [{
        label: 'Deploy',
        status: 'tracked',
        note: 'Checklist:\n\n- stage\n- verify',
        impact: 'Evidence: https://example.com/checks.',
        outcome: 'Complete.\n\n1. Stage\n2. Verify',
      }],
    })
    const board = listBoards(d)[0]!

    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(buttonLabelled('Plan flow', document.querySelector(`[data-card-id="${board.id}"]`)!))
    await settle()

    const mission = document.getElementById('missionbox')
    expect(mission?.querySelectorAll('.mission-node li')).toHaveLength(2)
    expect(mission?.querySelectorAll('.mission-result li')).toHaveLength(2)
    expectSafeLink(
      mission?.querySelector<HTMLAnchorElement>('.mission-node .structured-link') ?? null,
      'https://example.com/checks',
    )
  })
})
