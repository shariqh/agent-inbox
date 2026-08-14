// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import {
  advanceClock, bootApp, buttonLabelled, click, freshDb, navigateToHash, row, rowTitles,
  settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

describe('Needs-you deep-link lens reconciliation', () => {
  it('includes a target beyond page ten and clears filters that exclude the explicit target', async () => {
    db = freshDb()
    localStorage.setItem('agent-inbox-last-visit', new Date(Date.now() + 60_000).toISOString())
    const target = insertItem(db, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Explicit target',
      action_owner: 'approval',
      options: [{ label: 'Approve', recommended: true }],
    })
    for (let i = 0; i < 11; i++) {
      advanceClock()
      insertItem(db, {
        project: 'alpha',
        stream: 'main',
        agent: 'copilot',
        kind: 'question',
        title: `Alpha newer ${i}`,
        action_owner: 'approval',
      })
    }
    advanceClock()
    insertItem(db, {
      project: 'beta',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Beta copilot task',
      action_owner: 'task',
    })
    advanceClock()
    insertItem(db, {
      project: 'beta',
      stream: 'main',
      agent: 'claude',
      kind: 'question',
      title: 'Beta claude task',
      action_owner: 'task',
    })
    await bootApp(db)

    const sort = document.querySelector<HTMLSelectElement>('.queue-sort select')!
    sort.value = 'newest'
    sort.dispatchEvent(new Event('change', { bubbles: true }))
    click(document.querySelector('#rail button[data-project="beta"]'))
    const agent = document.getElementById('agentSelect') as HTMLSelectElement
    agent.value = 'claude'
    agent.dispatchEvent(new Event('change', { bubbles: true }))
    click(buttonLabelled('To do'))
    click(buttonLabelled('Updates'))
    expect(row(target)).toBeNull()

    navigateToHash(`#item/${target}`)
    await settle()

    expect((document.getElementById('search') as HTMLInputElement).value).toBe('')
    expect((document.getElementById('agentSelect') as HTMLSelectElement).value).toBe('')
    expect(document.querySelector('#rail button[data-project="alpha"]')?.getAttribute('aria-selected')).toBe('true')
    expect(buttonLabelled('All')?.classList.contains('active')).toBe(true)
    expect(buttonLabelled('Updates')?.classList.contains('active')).toBe(false)
    expect(rowTitles()).toContain('Explicit target')
    expect(row(target)?.dataset.open).toBe('1')
    expect(row(target)?.classList.contains('selected')).toBe(true)
    expect(document.activeElement).toBe(row(target))
  })
})
