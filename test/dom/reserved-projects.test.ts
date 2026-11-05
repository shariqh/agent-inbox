// @vitest-environment jsdom
// test/dom/reserved-projects.test.ts
//
// Issue #412: `@sessions` holds a driven session's approval alerts and can never
// be archived. The rail draws no Archive control for it and its tab takes no
// Delete key, and a store refusal of a close (200 `{ ok: false }`) unwinds the
// optimistic move instead of reading as success.
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, closedProjects } from '../../src/store.js'
import { advanceClock, badgeCount, bootApp, click, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const q = (d: Database.Database, project: string, title: string) =>
  insertItem(d, { project, stream: 'main', agent: 'copilot', kind: 'question', title })

const railTab = (project: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>(`#rail button.rail-tab[data-project="${project}"]`)]
    .find((el) => !el.closest('.closed-fold')) ?? null
const foldTab = (project: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`#rail .closed-fold button.rail-tab[data-project="${project}"]`)
const archiveControl = (project: string): HTMLElement | null =>
  railTab(project)?.parentElement?.querySelector<HTMLElement>('.rail-close') ?? null

describe('reserved projects in the rail (#412)', () => {
  it('draws no Archive control for @sessions, and its tab ignores Delete, while other projects keep theirs', async () => {
    db = freshDb()
    q(db, '@sessions', 'Allow copilot to run `npm test`?')
    advanceClock()
    q(db, 'alpha', 'Ship it?')
    const bridge = await bootApp(db)
    expect(railTab('@sessions')).toBeTruthy()
    expect(archiveControl('@sessions')).toBeNull()
    expect(archiveControl('alpha')).toBeTruthy()
    railTab('@sessions')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await settle()
    expect(bridge.posts.map((p) => p.url)).not.toContain('/api/projects/close')
    expect(badgeCount()).toBe(2)
  })

  it('unwinds a close the store refuses: the tab stays, nothing is archived, and the status line says why', async () => {
    db = freshDb()
    q(db, 'alpha', 'Ship it?')
    advanceClock()
    q(db, 'beta', 'Which pool?')
    const bridge = await bootApp(db, {
      interceptFetch: async (input, init, next) => String(input) === '/api/projects/close'
        ? new Response(JSON.stringify({ ok: false, reason: 'reserved_project' }), { status: 200, headers: { 'content-type': 'application/json' } })
        : await next(),
    })
    click(archiveControl('beta'))
    await settle()
    expect(bridge.posts.map((p) => p.url)).toContain('/api/projects/close')
    expect(closedProjects(db)).toEqual([])
    expect(railTab('beta')).toBeTruthy()
    expect(foldTab('beta')).toBeNull()
    expect(badgeCount()).toBe(2)
    expect(document.getElementById('status')!.textContent).toBe('beta can’t be archived: it holds sessions’ approvals')
  })
})
