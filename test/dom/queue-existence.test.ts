// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, snoozeItem } from '../../src/store.js'
import {
  bootApp, click, freshDb, navigateToHash, pollTick, row, settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const HOUR = 60 * 60_000

function open(): Database.Database {
  db = freshDb()
  return db
}

describe('Needs-you inspector existence reconciliation', () => {
  it('keeps a rendered inspector mounted across a Plans tab poll', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Inspector survives tab switch' })
    await bootApp(d)
    click(row(id))
    await settle()
    expect(row(id)?.querySelector('.nrow-card')).toBeTruthy()

    click(document.querySelector('#tabs [data-tab="boards"]'))
    await pollTick()

    expect(document.getElementById('needsYou')?.hidden).toBe(true)
    expect(row(id)?.dataset.open).toBe('1')
    expect(row(id)?.querySelector('.nrow-card')).toBeTruthy()
  })

  it('keeps stale and snoozed deep-link inspectors open through fold rebuilds', async () => {
    const d = open()
    const staleId = insertItem(d, { ...AGENT, kind: 'question', title: 'Stale deep link' })
    vi.setSystemTime(Date.now() + 73 * HOUR)
    const snoozedId = insertItem(d, { ...AGENT, kind: 'question', title: 'Snoozed deep link' })
    snoozeItem(d, snoozedId, new Date(Date.now() + 4 * HOUR).toISOString())
    await bootApp(d)

    navigateToHash(`#item/${staleId}`)
    await settle()
    await pollTick()
    expect(row(staleId)?.closest<HTMLDetailsElement>('.stale-fold')?.open).toBe(true)
    expect(row(staleId)?.dataset.open).toBe('1')

    navigateToHash(`#item/${snoozedId}`)
    await settle()
    await pollTick()
    expect(row(snoozedId)?.closest<HTMLDetailsElement>('.snoozed-fold')?.open).toBe(true)
    expect(row(snoozedId)?.dataset.open).toBe('1')
  })
})
