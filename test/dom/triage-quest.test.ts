// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertBoard } from '../../src/store.js'
import { bootApp, click, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

describe('Triage Quest milestone', () => {
  it('frames the existing deck as a focused run with progress and action mix', async () => {
    const d = open()
    insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Merge PR #42?',
      detail: 'All checks are green.',
      next_step: 'Choose whether to merge.',
      action_owner: 'approval',
      impact: 'Unblocks implementation.',
      next_after: 'The agent dispatches the next PR.',
      options: [{ label: 'Merge', recommended: true }, { label: 'Hold' }],
    })
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Upload notarized build',
        status: 'blocked',
        note: 'The signed artifact is ready.',
        next_step: 'Upload the build.',
        action_owner: 'task',
        impact: 'Required for release.',
        next_after: 'The agent publishes the release.',
      }],
    })

    await bootApp(d)
    click(document.querySelector('.triage-btn'))
    await settle()

    const lightbox = document.getElementById('lightbox')!
    expect(lightbox.querySelector('.lb-kicker')?.textContent).toBe('Focus run')
    expect(lightbox.querySelector('.lb-count')?.textContent).toBe('1 of 2')
    expect(lightbox.querySelector('.lb-mix')?.textContent).toContain('1 decision')
    expect(lightbox.querySelector('.lb-mix')?.textContent).toContain('1 task')
    expect(lightbox.querySelector('.lb-owner')?.textContent).toBe('Agent acts after approval')
    expect(lightbox.querySelector<HTMLElement>('.lb-progress-fill')?.style.width).toBe('50%')
    expect(lightbox.querySelector('.lb-shortcuts')?.textContent).toContain('1-4 choose')
    expect(lightbox.querySelector('.lb-card')?.textContent).toContain('Unblocks implementation.')
  })

  it('uses Skip and Back to move between action shapes without mutating them', async () => {
    const d = open()
    insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Publish?',
      detail: 'The release is ready.',
      next_step: 'Choose whether to publish.',
      action_owner: 'approval',
      impact: 'Makes the release public.',
      options: [{ label: 'Publish', recommended: true }, { label: 'Hold' }],
    })
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Send outreach',
        status: 'blocked',
        note: 'The message kit is ready.',
        next_step: 'Send the first three messages.',
        action_owner: 'task',
        impact: 'Starts the evidence loop.',
      }],
    })

    await bootApp(d)
    click(document.querySelector('.triage-btn'))
    await settle()
    const lightbox = document.getElementById('lightbox')!

    click(lightbox.querySelector('.lb-next'))
    await settle()
    expect(lightbox.querySelector('.lb-count')?.textContent).toBe('2 of 2')
    expect(lightbox.querySelector('.lb-owner')?.textContent).toBe('You do')
    expect(lightbox.querySelector('.lb-card')?.textContent).toContain('Send outreach')

    click(lightbox.querySelector('.lb-prev'))
    await settle()
    expect(lightbox.querySelector('.lb-count')?.textContent).toBe('1 of 2')
    expect(lightbox.querySelector('.lb-owner')?.textContent).toBe('Agent acts after approval')
    expect(lightbox.querySelector('.lb-card')?.textContent).toContain('Publish?')
  })
})
