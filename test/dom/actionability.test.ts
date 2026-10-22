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
  it('leads with the request and keeps all warnings visible ahead of collapsed tracking details', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      stream: 'feat/internal-rollout-132',
      title: 'Launch',
      rows: [{
        label: 'Design-partner outreach',
        status: 'blocked',
        note: 'The outreach kit is ready; nothing has been sent.',
        next_step: 'Choose the tracker and send the first three messages.',
        impact: 'The first replies will help us choose the release date.',
        next_after: 'Review the replies together.',
        context: 'Candidate profiles, venue research, message drafts, and cadence details live here.',
      }],
    })
    const rowId = listBoards(d)[0]!.rows[0]!.id

    await bootApp(d)
    expect(row(rowId)?.querySelector('.nrow-title')?.textContent)
      .toBe('Choose the tracker and send the first three messages.')
    expect(row(rowId)?.querySelector('.nrow-sec')?.textContent)
      .toBe('The outreach kit is ready; nothing has been sent.')
    expect(row(rowId)?.querySelector('.nrow-stream')).toBeNull()

    click(row(rowId))
    await settle()
    const card = row(rowId)?.querySelector('.nrow-card')
    expect([...card!.querySelectorAll('.card-section-label')].map((label) => label.textContent))
      .toEqual(['Why it matters', 'Then'])
    expect(card?.querySelectorAll('.card-title')).toHaveLength(1)
    expect(card?.querySelector('.card-title')?.textContent)
      .toBe('Choose the tracker and send the first three messages.')
    expect(card?.querySelector('.card-next')).toBeNull()
    expect(card?.querySelector('.card-tldr')?.textContent)
      .toContain('The outreach kit is ready; nothing has been sent.')
    expect(card?.querySelector('.card-impact')?.textContent)
      .toContain('The first replies will help us choose the release date.')
    expect(card?.querySelector('.card-after')?.textContent).toContain('Review the replies together.')
    const background = card?.querySelector<HTMLDetailsElement>('.card-context')
    expect(background?.open).toBe(false)
    expect(background?.querySelector('summary')?.textContent).toBe('Details & history')
    expect(background?.querySelector('.card-original-title')?.textContent).toBe('Design-partner outreach')
    expect(background?.querySelector('.card-meta')?.textContent).toContain('feat/internal-rollout-132')
    expect(background?.textContent).toContain('Candidate profiles')
    for (const selector of ['.card-tldr', '.card-impact', '.card-after']) {
      expect(card?.querySelector(selector)?.closest('details')).toBeNull()
    }
    expect(card?.querySelector('.nrow-card-compose > .row-answer')).not.toBeNull()
  })

  it('gives question items the same next-step, summary, collapsed-background order', async () => {
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
    expect(card?.querySelector('.card-section-label')).toBeNull()
    expect(card?.querySelectorAll('.card-title')).toHaveLength(1)
    expect(card?.querySelector('.card-title')?.textContent).toBe('Choose Merge now (recommended) or Hold.')
    expect(card?.querySelector('.card-tldr')?.textContent)
      .toContain('Six review rounds are complete and every gate is green.')
    expect(card?.querySelector<HTMLDetailsElement>('.card-context')?.open).toBe(false)
    expect(card?.querySelector('.nrow-card-compose > .actions')).not.toBeNull()
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
    expect(row(rowId)?.querySelector('.nrow-title')?.textContent).toBe('#334 PR-X0 spec (#582)')
  })

  it('uses the same request and full explanation in Review queue and Plans', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT, title: 'Release',
      rows: [{
        label: 'R-14 technical gate', status: 'blocked',
        next_step: 'Approve the release after verifying the backup.',
        note: 'The older client will stop working. Do not skip the backup.',
        impact: 'The older client will stop working. Do not skip the backup.',
        next_after: 'The agent will publish and check the service.',
        options: [
          { label: 'Approve', detail: 'Customers receive the update.', recommended: true },
          { label: 'Hold', detail: 'No customer changes yet.' },
        ],
      }],
    })
    await bootApp(d)
    click(document.querySelector('.triage-btn'))
    await settle()
    const review = document.querySelector('#lightbox .lb-row-card')!
    expect(review.querySelector('.card-title')?.textContent).toBe('Approve the release after verifying the backup.')
    expect(review.querySelectorAll('.card-tldr, .card-impact')).toHaveLength(1)
    expect(review.querySelector('.card-tldr')?.textContent).toContain('Do not skip the backup.')
    expect(review.querySelector('.card-context .card-original-title')?.textContent).toBe('R-14 technical gate')
    click(document.querySelector('#lightbox .lb-close'))
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector('#boards .board-row'))
    await settle()
    const plan = document.querySelector('#boards .row-panel')!
    expect(plan.querySelector('.card-title')?.textContent).toBe('Approve the release after verifying the backup.')
    expect(plan.querySelector('.card-tldr')?.textContent).toContain('Do not skip the backup.')
    expect(plan.querySelector('.row-options.comparing .opt-detail')?.textContent).toBe('Customers receive the update.')
  })
})
