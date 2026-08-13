// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, insertItem, upsertBoard } from '../../src/store.js'
import {
  answerInput, bootApp, buttonLabelled, click, expectConsoleError, freshDb, pollTick, row,
  settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

function deferPost(match: string, response?: Response): () => void {
  const fetchNow = globalThis.fetch
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST' && String(input).includes(match)) {
      await gate
      if (response) return response
    }
    return fetchNow(input, init)
  }
  return release
}

function boardPanelInput(rowId: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(
    `#boards [data-row-id="${rowId}"] + .row-panel-row .reply-input`,
  )!
}

describe('async draft ownership', () => {
  it('does not let a late row save erase newer text typed in a duplicate editor', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Duplicate editors',
      rows: [{ label: 'Approve launch', status: 'blocked', note: 'Choose now.' }],
    })
    const board = getBoard(db, 'alpha', 'Duplicate editors')!
    const rowId = board.rows[0]!.id
    await bootApp(db)

    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(buttonLabelled('Answer', document.querySelector(`[data-row-id="${rowId}"]`)!))
    await settle()
    click(buttonLabelled('Review queue'))
    await settle()

    const lightbox = document.getElementById('lightbox')!
    const triageInput = lightbox.querySelector<HTMLInputElement>('.reply-input')!
    type(triageInput, 'submission A')
    const release = deferPost(`/rows/${rowId}/annotate`)
    click(buttonLabelled('Send', lightbox))
    type(boardPanelInput(rowId), 'newer draft B')
    release()
    await settle()

    expect(getBoard(db, 'alpha', 'Duplicate editors')!.rows[0]!.annotation).toBe('submission A')
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('newer draft B')
  })

  it('does not restore a failed row submission over a newer draft', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Failed save',
      rows: [{ label: 'Approve launch', status: 'blocked', note: 'Choose now.' }],
    })
    const rowId = getBoard(db, 'alpha', 'Failed save')!.rows[0]!.id
    await bootApp(db)

    click(row(rowId))
    await settle()
    const input = answerInput(rowId)!
    type(input, 'submission A')
    expectConsoleError(/annotate failed: HTTP 503/)
    const release = deferPost(`/rows/${rowId}/annotate`, new Response('offline', { status: 503 }))
    click(buttonLabelled('Send', row(rowId)!))
    type(input, 'newer draft B')
    release()
    await settle()

    expect(answerInput(rowId)?.value).toBe('newer draft B')
    expect(document.querySelector('.stale-drafts-fold')?.textContent ?? '').not.toContain('submission A')
  })

  it('does not let a late row CAS refusal displace a newer draft', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Refused save',
      rows: [{ label: 'Approve launch', status: 'blocked', note: 'Choose now.' }],
    })
    const rowId = getBoard(db, 'alpha', 'Refused save')!.rows[0]!.id
    await bootApp(db)

    click(row(rowId))
    await settle()
    const input = answerInput(rowId)!
    type(input, 'submission A')
    const release = deferPost(`/rows/${rowId}/annotate`, new Response(
      JSON.stringify({ ok: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    click(buttonLabelled('Send', row(rowId)!))
    type(input, 'newer draft B')
    release()
    await settle()

    expect(answerInput(rowId)?.value).toBe('newer draft B')
    expect(document.querySelector('.stale-drafts-fold')?.textContent ?? '').not.toContain('submission A')
  })

  it('recovers the later of two option submissions when the earlier one wins the CAS race', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Option race',
      rows: [{
        label: 'Choose rollout',
        status: 'blocked',
        note: 'Pick one.',
        options: [{ label: 'Ship now' }, { label: 'Hold' }],
      }],
    })
    const rowId = getBoard(db, 'alpha', 'Option race')!.rows[0]!.id
    await bootApp(db)
    click(row(rowId))
    await settle()

    const release = deferPost(`/rows/${rowId}/annotate`)
    click(buttonLabelled('Ship now', row(rowId)!))
    click(buttonLabelled('Hold', row(rowId)!))
    release()
    await settle()

    expect(getBoard(db, 'alpha', 'Option race')!.rows[0]!.annotation).toBe('Ship now')
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Hold')
  })

  it('preserves a newer item answer when an earlier successful reply completes', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Ship it?' })
    await bootApp(db)

    click(row(id))
    await settle()
    const input = answerInput(id)!
    type(input, 'submission A')
    const release = deferPost(`/items/${id}/reply`)
    click(buttonLabelled('Send', row(id)!))
    type(input, 'newer draft B')
    release()
    await settle()

    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('newer draft B')
    expect(row(id)?.textContent).toContain('submission A')
  })

  it('does not let a delayed staged-star reply retire a draft typed after staging', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Pick rollout',
      detail: 'Choose the rollout timing.',
      options: [{ label: 'Ship now', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(db)

    click(row(id)?.querySelector('.star-btn'))
    click(row(id))
    await settle()
    type(answerInput(id), 'newer draft B')
    await vi.advanceTimersByTimeAsync(5000)
    await settle()

    expect(row(id)?.textContent).toContain('Ship now')
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('newer draft B')
  })
})

describe('direct overlay draft reconciliation', () => {
  it('recovers a removed row before Review queue navigation can retire its editor', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Removed owner',
      rows: [{ label: 'Draft owner A', status: 'blocked', note: 'Choose.' }],
    })
    const original = getBoard(db, 'alpha', 'Removed owner')!
    const rowId = original.rows[0]!.id
    insertItem(db, { ...AGENT, kind: 'question', title: 'Review target B' })
    await bootApp(db)

    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'draft owned by removed A')
    upsertBoard(db, {
      ...AGENT,
      title: 'Removed owner',
      expectedVersion: original.revision,
      rows: [],
    })
    await pollTick()

    click(buttonLabelled('Review queue'))
    await settle()

    expect(document.getElementById('lightbox')?.hidden).toBe(true)
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('draft owned by removed A')
    expect(document.getElementById('pauseHint')?.textContent).toBe('')
  })

  it('recovers a removed mission editor before navigating to another Plan row', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Mission owners',
      rows: [
        { label: 'Draft owner A', status: 'blocked', note: 'Choose A.' },
        { label: 'Mission target B', status: 'blocked', note: 'Choose B.' },
      ],
    })
    const original = getBoard(db, 'alpha', 'Mission owners')!
    const owner = original.rows[0]!
    await bootApp(db)

    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(buttonLabelled('Plan flow'))
    const missionBox = document.getElementById('missionbox')!
    const missionButton = (label: string): HTMLButtonElement =>
      [...missionBox.querySelectorAll<HTMLButtonElement>('.mission-node')]
        .find((button) => button.textContent?.includes(label))!
    click(missionButton('Draft owner A'))
    await settle()
    type(document.querySelector<HTMLInputElement>('#missionbox .mission-detail .reply-input'), 'mission draft A')
    upsertBoard(db, {
      ...AGENT,
      title: 'Mission owners',
      expectedVersion: original.revision,
      rows: [{
        label: 'Mission target B',
        revision: original.rows[1]!.revision,
        status: 'blocked',
        note: 'Choose B.',
      }],
    })
    await pollTick()

    click(missionButton('Mission target B'))
    await settle()

    expect(document.getElementById('missionbox')?.hidden).toBe(true)
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('mission draft A')
  })

  it('preserves the focused Review queue control across poll rerenders', async () => {
    db = freshDb()
    insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Review focus',
      options: [{ label: 'Approve' }, { label: 'Hold' }],
    })
    await bootApp(db)
    click(buttonLabelled('Review queue'))
    await settle()

    const lightbox = document.getElementById('lightbox')!
    const before = buttonLabelled('Hold', lightbox)!
    before.focus()
    await pollTick()

    const after = buttonLabelled('Hold', lightbox)!
    expect(before.isConnected).toBe(false)
    expect(document.activeElement).toBe(after)
  })
})
