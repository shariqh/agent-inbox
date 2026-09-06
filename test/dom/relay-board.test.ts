// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import {
  annotateBoardRow, insertItem, markReplySeen, replyItem, resolveItem, listItems,
  upsertBoard, listBoards,
} from '../../src/store.js'
import { advanceClock, bootApp, click, freshDb, row, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

describe('Handoffs milestone', () => {
  it('projects the live workflow into Waiting on you, With the agent, and Outcome lanes', async () => {
    const d = open()
    insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Merge?',
      detail: 'All gates are green.',
      action_owner: 'approval',
    })
    advanceClock()
    const agentItem = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Publish?',
      detail: 'The release is ready.',
      action_owner: 'approval',
    })
    replyItem(d, agentItem, 'Publish')
    const answered = listItems(d).find((item) => item.id === agentItem)!
    markReplySeen(d, agentItem, answered.replied_at)
    advanceClock()
    const doneItem = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Ship?',
      detail: 'The canary is green.',
      action_owner: 'approval',
    })
    resolveItem(d, doneItem, 'Release shipped successfully.')
    advanceClock()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Upload build',
        status: 'blocked',
        note: 'The artifact is ready.',
        action_owner: 'task',
      }],
    })
    const board = listBoards(d)[0]!
    annotateBoardRow(d, board.rows[0]!.id, 'Uploaded')

    await bootApp(d)
    click(document.querySelector('.relay-btn'))
    await settle()

    const relay = document.getElementById('relaybox')!
    expect(relay.hidden).toBe(false)
    expect(relay.querySelector('.relay-summary')?.textContent).toBe('1 waiting on you · 2 with agent · 1 outcomes')
    expect(relay.querySelectorAll('[data-relay-lane="human"] .relay-card')).toHaveLength(1)
    expect(relay.querySelectorAll('[data-relay-lane="agent"] .relay-card')).toHaveLength(2)
    expect(relay.querySelectorAll('[data-relay-lane="outcome"] .relay-card')).toHaveLength(1)
    expect(relay.querySelector('[data-relay-lane="agent"]')?.textContent).toContain('Publish?')
    expect(relay.querySelector('[data-relay-lane="agent"]')?.textContent).toContain('Upload build')
    expect(relay.querySelector('[data-relay-lane="agent"]')?.textContent).toContain('delivered moments')
    expect(relay.querySelector('[data-relay-lane="agent"]')?.textContent).toContain('Waiting for delivery')
    expect(relay.querySelector('[data-relay-lane="outcome"]')?.textContent).toContain('Release shipped successfully.')

    const openButton = relay.querySelector<HTMLButtonElement>('.relay-open')!
    openButton.focus()
    openButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(relay.hidden).toBe(true)
  })

  it('routes handoff cards back to their existing card rather than owning duplicate actions', async () => {
    const d = open()
    const agentItem = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Publish?',
      detail: 'The release is ready.',
      action_owner: 'approval',
    })
    replyItem(d, agentItem, 'Publish')
    advanceClock()
    const doneItem = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Ship?',
      action_owner: 'approval',
    })
    resolveItem(d, doneItem, 'Release shipped.')

    await bootApp(d)
    click(document.querySelector('.relay-btn'))
    await settle()
    click(document.querySelector('[data-relay-lane="agent"] .relay-open'))
    await settle()

    expect(document.getElementById('relaybox')?.hidden).toBe(true)
    expect(row(agentItem)?.dataset['open']).toBe('1')

    click(document.querySelector('.relay-btn'))
    await settle()
    click(document.querySelector('[data-relay-lane="outcome"] .relay-open'))
    await settle()
    expect(document.querySelector('.tab[data-tab="done"]')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector(`[data-card-id="${doneItem}"]`)).not.toBeNull()
  })
})
