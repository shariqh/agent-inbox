// @vitest-environment jsdom
// #chats opens the Chats tab (#586 PR 2), on boot and on hashchange, without
// taking over #item/<id>. Its own file: hashchange listeners pile up across boots.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import type { ChatIndex } from '../../src/chat-index.js'
import { advanceClock, bootApp, freshDb, navigateToHash, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

async function boot(seed: (d: Database.Database) => void = () => {}) {
  db = freshDb()
  seed(db)
  const chatIndex: ChatIndex = {
    read: () => ({
      chats: [{
        id: '00000000-0000-4000-8000-000000000001', tool: 'claude', title: 'Chat 1', titleAuto: false, project: 'alpha',
        cwd: '/Users/tester/dev/alpha', branch: 'main', createdAt: null, lastActiveAt: null, live: false, pr: null, hidden: [],
      }],
      truncated: false,
      work: { filesRead: 0, bytesRead: 0 },
    }),
    readCopilot: () => null,
    claudeDays: () => 30,
  }
  const reads: string[] = []
  await bootApp(db, {
    viewer: { chatIndex },
    interceptFetch: async (input, _init, next) => {
      if (String(input).startsWith('/api/chats')) reads.push(String(input))
      return await next()
    },
  })
  return reads
}

const shown = () => !document.getElementById('chats')!.hidden

describe('#chats deep link (#586 PR 2)', () => {
  // One app per hash test: an earlier boot's hashchange listener would show the panel first.
  it('opens Chats on boot with one read, and again on hashchange', async () => {
    location.hash = '#chats'
    const reads = await boot()
    expect(shown()).toBe(true)
    expect(document.getElementById('pageTitle')?.textContent).toBe('Chats')
    expect(reads).toEqual(['/api/chats'])
    expect(document.querySelectorAll('#chats tbody tr')).toHaveLength(1)

    document.querySelector<HTMLElement>('.tab[data-tab="dashboard"]')!.click()
    await settle()
    expect(shown()).toBe(false)
    advanceClock(61_000)
    navigateToHash('#chats')
    await settle()
    expect(shown()).toBe(true)
    expect(reads).toHaveLength(2)
  })

  it('leaves #item/<id> to its item', async () => {
    let id = ''
    const reads = await boot((d) => {
      id = insertItem(d, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'note', title: 'A note' })
    })
    navigateToHash(`#item/${encodeURIComponent(id)}`)
    await settle()
    expect(shown()).toBe(false)
    expect(document.getElementById('notes')!.hidden).toBe(false)
    expect(reads).toEqual([])
  })
})
