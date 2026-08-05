// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listBoards, upsertBoard } from '../../src/store.js'
import { bootApp, buttonLabelled, click, freshDb, pollTick, row, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

describe('action-first attention cards', () => {
  it('shows a blocked row next step before its TL;DR and keeps background collapsed', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Design-partner outreach',
        status: 'blocked',
        note: 'The outreach kit is ready; nothing has been sent.',
        next_step: 'Choose the tracker and send the first three messages.',
        context: 'Candidate profiles, venue research, message drafts, and cadence details live here.',
      }],
    })
    const rowId = listBoards(d)[0]!.rows[0]!.id

    await bootApp(d)
    expect(row(rowId)?.querySelector('.nrow-sec')?.textContent)
      .toBe('Next: Choose the tracker and send the first three messages.')

    click(row(rowId))
    await settle()
    const card = row(rowId)?.querySelector('.nrow-card')
    expect(card?.querySelector('.card-next')?.textContent)
      .toContain('Choose the tracker and send the first three messages.')
    expect(card?.querySelector('.card-tldr')?.textContent)
      .toContain('The outreach kit is ready; nothing has been sent.')
    const background = card?.querySelector<HTMLDetailsElement>('.card-context')
    expect(background?.open).toBe(false)
    expect(background?.textContent).toContain('Candidate profiles')
  })

  it('gives question items the same next-step, TL;DR, collapsed-background order', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Merge PR #42?',
      detail: 'Six review rounds are complete and every gate is green.',
      next_step: 'Choose Merge now (recommended) or Hold.',
      context: 'The full review disposition and amendment history is intentionally long.',
    })

    await bootApp(d)
    click(row(id))
    await settle()
    const card = row(id)?.querySelector('.nrow-card')
    expect(card?.querySelector('.card-next')?.textContent)
      .toContain('Choose Merge now (recommended) or Hold.')
    expect(card?.querySelector('.card-tldr')?.textContent)
      .toContain('Six review rounds are complete and every gate is green.')
    expect(card?.querySelector<HTMLDetailsElement>('.card-context')?.open).toBe(false)
  })

  it('keeps Background open across forced and polling rebuilds', async () => {
    const d = open()
    const itemId = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Merge?',
      detail: 'All gates are green.',
      next_step: 'Choose whether to merge.',
      context: 'Item background that must stay open.',
    })
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Deploy',
        status: 'blocked',
        note: 'The build is ready.',
        context: 'Board-row background that must stay open.',
      }],
    })

    await bootApp(d)
    click(row(itemId))
    await settle()
    let background = row(itemId)?.querySelector<HTMLDetailsElement>('.card-context')
    background!.open = true
    background!.dispatchEvent(new window.Event('toggle'))
    const allFilter = [...document.querySelectorAll<HTMLButtonElement>('#needsYouList .header-toggle')]
      .find((button) => button.textContent === 'All')
    click(allFilter)
    await settle()
    background = row(itemId)?.querySelector<HTMLDetailsElement>('.card-context')
    expect(background?.open).toBe(true)

    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector('#boards .board-row'))
    await settle()
    background = document.querySelector<HTMLDetailsElement>('#boards .row-panel .card-context')
    background!.open = true
    background!.dispatchEvent(new window.Event('toggle'))
    await pollTick()
    background = document.querySelector<HTMLDetailsElement>('#boards .row-panel .card-context')
    expect(background?.open).toBe(true)
  })

  it('renders blocked-row decisions as direct choices and records the selected answer', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Structured notes',
      rows: [{
        label: '#334 PR-X0 spec (#582)',
        status: 'blocked',
        note: 'The spec is settled and every review gate is green.',
        next_step: 'Choose whether to merge PR #582.',
        options: [
          { label: 'Merge PR #582', detail: 'Dispatch PR-X immediately.', recommended: true },
          { label: 'Hold', detail: 'Leave the implementation blocked.' },
        ],
      }],
    })
    const rowId = listBoards(d)[0]!.rows[0]!.id

    await bootApp(d)
    click(row(rowId))
    await settle()
    const card = row(rowId)?.querySelector('.nrow-card')
    const merge = card?.querySelector<HTMLButtonElement>('.opt-pill.rec')
    expect(merge?.textContent).toContain('Merge PR #582')
    expect(buttonLabelled('Hold', card!)).not.toBeNull()
    expect(buttonLabelled('I’ve done my part', card!)).toBeNull()

    click(merge)
    await settle()
    expect(listBoards(d)[0]!.rows[0]!.annotation).toBe('Merge PR #582')
  })
})
