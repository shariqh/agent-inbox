// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { bootApp, freshDb, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

function open(): Database.Database {
  db = freshDb()
  return db
}

describe('floating workspace search', () => {
  it('lives outside the header while the agent picker belongs to the responsive sidebar', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Search target',
    })

    await bootApp(d)

    const search = document.getElementById('search')!
    const agent = document.querySelector('.agent-pick')!
    expect(search.closest('.floating-search')?.getAttribute('role')).toBe('search')
    expect(search.getAttribute('aria-keyshortcuts')).toBe('Meta+K Control+K')
    expect(document.getElementById('topbar')?.contains(search)).toBe(false)
    expect(document.querySelector('.sidebar-shell')?.contains(agent)).toBe(true)
    expect(document.getElementById('topbar')?.contains(agent)).toBe(false)
  })

  it('focuses and selects the query from Command/Ctrl+K even when a native select owns focus', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Search target',
    })

    await bootApp(d)

    const search = document.getElementById('search') as HTMLInputElement
    const agent = document.getElementById('agentSelect') as HTMLSelectElement
    search.value = 'existing query'
    agent.focus()

    const command = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    agent.dispatchEvent(command)
    expect(command.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(search)
    expect(search.selectionStart).toBe(0)
    expect(search.selectionEnd).toBe(search.value.length)

    agent.focus()
    const control = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    agent.dispatchEvent(control)
    expect(control.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(search)

    agent.focus()
    const shifted = new KeyboardEvent('keydown', {
      key: 'K',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    agent.dispatchEvent(shifted)
    expect(shifted.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(agent)
  })

  it('does not move focus behind an open modal', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Search target',
    })
    await bootApp(d)
    const review = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Review queue')!
    review.click()
    const panel = document.querySelector<HTMLElement>('#lightbox .lb-panel')!
    expect(document.activeElement).toBe(panel)

    const command = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    panel.dispatchEvent(command)

    expect(command.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(panel)
    expect(document.getElementById('lightbox')?.hidden).toBe(false)
  })
})
