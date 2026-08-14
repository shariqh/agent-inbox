// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { bootApp, click, freshDb, row, settle, T0, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

it('does not rebuild the expanded queue while page scroll momentum is active', async () => {
  db = freshDb()
  const id = insertItem(db, {
    project: 'alpha',
    stream: 'viewer',
    agent: 'copilot',
    session: 'session-page-scroll',
    kind: 'question',
    title: 'Keep the page stable while scrolling',
  })

  await bootApp(db)
  click(row(id))
  await settle()
  const before = row(id)

  const untilNextPoll = 3000 - ((Date.now() - T0) % 3000)
  await vi.advanceTimersByTimeAsync(untilNextPoll - 50)
  window.dispatchEvent(new Event('scroll'))
  await vi.advanceTimersByTimeAsync(50)
  await settle()

  expect(row(id)).toBe(before)

  await vi.advanceTimersByTimeAsync(100)
  window.dispatchEvent(new Event('scroll'))
  await vi.advanceTimersByTimeAsync(150)
  expect(row(id)).toBe(before)

  await vi.advanceTimersByTimeAsync(50)
  await settle()
  expect(row(id)).not.toBe(before)
})

it('keeps polling normally during page scrolling when no row is expanded', async () => {
  db = freshDb()
  const id = insertItem(db, {
    project: 'alpha',
    stream: 'viewer',
    agent: 'copilot',
    session: 'session-page-scroll',
    kind: 'question',
    title: 'Keep the closed queue current',
  })

  await bootApp(db)
  const before = row(id)

  const untilNextPoll = 3000 - ((Date.now() - T0) % 3000)
  await vi.advanceTimersByTimeAsync(untilNextPoll - 50)
  window.dispatchEvent(new Event('scroll'))
  await vi.advanceTimersByTimeAsync(50)
  await settle()

  expect(row(id)).not.toBe(before)
})
