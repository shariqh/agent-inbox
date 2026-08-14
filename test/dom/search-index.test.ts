// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { archiveBoard, getBoard, insertItem, listBoards, upsertBoard } from '../../src/store.js'
import {
  advanceClock, bootApp, click, freshDb, pollTick, row, rowTitles, searchFor, settle, type, useDomTest,
} from './harness.js'

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

function input(): HTMLInputElement {
  return document.getElementById('search') as HTMLInputElement
}

function results(): HTMLElement {
  return document.getElementById('searchResults')!
}

function option(target: string): HTMLElement | null {
  return results().querySelector(`[role="option"][data-search-target="${target}"]`)
}

describe('workspace search index', () => {
  it('clears, closes, and exits search on Escape without letting a pending debounce reopen it', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Choose the launch window',
    })
    await bootApp(d)

    expect(input().getAttribute('role')).toBe('combobox')
    expect(input().getAttribute('aria-controls')).toBe('searchResults')
    expect(input().getAttribute('aria-expanded')).toBe('false')

    input().focus()
    type(input(), 'launch')
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    input().dispatchEvent(escape)
    await vi.advanceTimersByTimeAsync(200)

    expect(escape.defaultPrevented).toBe(true)
    expect(input().value).toBe('')
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(results().hidden).toBe(true)
    expect(document.activeElement).not.toBe(input())
  })

  it('shows clickable item results without narrowing the queue, then opens the selected item', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Unrelated budget review',
    })
    advanceClock()
    const target = insertItem(d, {
      project: 'beta',
      stream: 'release',
      agent: 'claude',
      kind: 'question',
      title: 'Choose the launch window',
      detail: 'Pick the safest production slot.',
    })
    await bootApp(d)
    const before = rowTitles().sort()

    await searchFor('launch')

    expect(rowTitles().sort()).toEqual(before)
    expect(results().hidden).toBe(false)
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(option(target)?.textContent).toContain('Choose the launch window')
    expect(option(target)?.textContent).toContain('Open item')
    expect(option(target)?.textContent).toContain('beta')
    expect(option(target)?.tabIndex).toBe(-1)
    expect(document.getElementById('searchStatus')?.textContent).toContain('1 search result')

    const pointerDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    option(target)?.dispatchEvent(pointerDown)
    expect(pointerDown.defaultPrevented).toBe(true)
    click(option(target))
    await settle()

    expect(input().value).toBe('')
    expect(results().hidden).toBe(true)
    expect(row(target)?.dataset['open']).toBe('1')
  })

  it('opens and highlights the exact Background source when activating an item result', async () => {
    const d = open()
    const target = insertItem(d, {
      project: 'alpha',
      stream: 'release',
      agent: 'copilot',
      kind: 'question',
      title: 'Choose the launch window',
      context: 'The canary window is the safest production slot.',
    })
    await bootApp(d)
    await searchFor('canary')

    click(option(target))
    await settle()

    let background = row(target)?.querySelector<HTMLDetailsElement>('.card-context')
    expect(background?.open).toBe(true)
    expect(background?.querySelector('.search-jump-highlight')?.textContent).toBe('canary')
    expect(document.activeElement).toBe(background?.querySelector('summary'))

    await pollTick()
    background = row(target)?.querySelector<HTMLDetailsElement>('.card-context')
    expect(background?.open).toBe(true)
    expect(background?.querySelector('.search-jump-highlight')?.textContent).toBe('canary')

    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await settle()
    background = row(target)?.querySelector<HTMLDetailsElement>('.card-context')
    expect(background?.querySelector('.search-jump-highlight')?.textContent).toBe('canary')

    background!.open = false
    background!.dispatchEvent(new window.Event('toggle'))
    await pollTick()
    expect(row(target)?.querySelector<HTMLDetailsElement>('.card-context')?.open).toBe(false)
  })

  it('opens the owning plan row and highlights its matched Background source', async () => {
    const d = open()
    upsertBoard(d, {
      project: 'alpha',
      stream: 'release',
      agent: 'copilot',
      title: 'Launch readiness',
      rows: [{
        label: 'Deploy canary',
        status: 'tracked',
        note: 'The build is ready.',
        context: 'The Portugal region is the safest canary.',
      }],
    })
    const board = listBoards(d)[0]!
    const targetRow = board.rows[0]!
    await bootApp(d)
    await searchFor('Portugal')

    click(option(board.id))
    await settle()

    const panel = document.querySelector(`.row-panel-row[data-row-id="${targetRow.id}"]`)
    const background = panel?.querySelector<HTMLDetailsElement>('.card-context')
    expect(document.getElementById('boards')?.hidden).toBe(false)
    expect(background?.open).toBe(true)
    expect(background?.querySelector('.search-jump-highlight')?.textContent).toBe('Portugal')
    expect(document.activeElement).toBe(background?.querySelector('summary'))
  })

  it('highlights a matched plan-row label at its visible source', async () => {
    const d = open()
    upsertBoard(d, {
      project: 'alpha',
      stream: 'release',
      agent: 'copilot',
      title: 'Regional rollout',
      rows: [{
        label: 'Auckland deployment lane',
        status: 'tracked',
        note: 'The build is ready.',
      }],
    })
    const board = listBoards(d)[0]!
    await bootApp(d)
    await searchFor('Auckland')

    click(option(board.id))
    await settle()

    expect(document.querySelector('.board-row .row-label .search-jump-highlight')?.textContent)
      .toBe('Auckland')
  })

  it('ranks the strongest match first and highlights it instead of preserving queue order', async () => {
    const d = open()
    const strongest = insertItem(d, {
      project: 'zeta',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Search results index',
    })
    advanceClock()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Search validation',
      detail: 'Results index coverage is pending.',
    })
    await bootApp(d)

    await searchFor('search results')

    const options = [...results().querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options[0]?.dataset['searchTarget']).toBe(strongest)
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    expect(input().getAttribute('aria-activedescendant')).toBe(options[0]?.id)
  })

  it('highlights visible title matches and explains hidden-field matches without parsing authored HTML', async () => {
    const d = open()
    const titleTarget = insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Covered policy <img src=x onerror=alert(1)>',
    })
    advanceClock()
    const detailTarget = insertItem(d, {
      project: 'beta',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Policy explanation',
      detail: 'This service is covered by the approved controls.',
    })
    await bootApp(d)

    await searchFor('covered')

    expect(option(titleTarget)?.querySelector('.search-result-main mark')?.textContent).toBe('Covered')
    expect(option(titleTarget)?.querySelector('img')).toBeNull()
    expect(option(detailTarget)?.querySelector('.search-result-match-source')?.textContent).toBe('Details')
    expect(option(detailTarget)?.querySelector('.search-result-match mark')?.textContent).toBe('covered')
  })

  it('renders the lifecycle hierarchy from open work through archived plans', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Covered open item',
    })
    advanceClock()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'note',
      title: 'Covered note',
    })
    advanceClock()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'done',
      title: 'Covered history',
    })
    upsertBoard(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      title: 'Covered active plan',
      rows: [],
    })
    upsertBoard(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      title: 'Covered archived plan',
      rows: [],
    })
    const archived = getBoard(d, 'alpha', 'Covered archived plan')!
    expect(archiveBoard(d, archived.id, archived.revision)).toBe(true)
    await bootApp(d)

    await searchFor('covered')

    expect([...results().querySelectorAll('.search-result-group-label')].map((label) => label.textContent))
      .toEqual(['Open items', 'Active plans', 'Notes', 'History', 'Archived plans'])
  })

  it('closes outside the dock, preserves the query, and reopens when the combobox regains focus', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Choose the launch window',
    })
    await bootApp(d)
    await searchFor('launch')
    input().focus()

    document.querySelector('#tabs')?.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
    }))
    expect(results().hidden).toBe(true)
    expect(input().value).toBe('launch')
    expect(document.activeElement).not.toBe(input())

    input().focus()
    expect(results().hidden).toBe(false)
    expect(input().getAttribute('aria-expanded')).toBe('true')

    input().blur()
    expect(results().hidden).toBe(true)
    expect(input().value).toBe('launch')
  })

  it('cancels a pending query when focus leaves so dismissal cannot reopen the index', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Choose the launch window',
    })
    await bootApp(d)

    input().focus()
    type(input(), 'launch')
    document.querySelector('#tabs')?.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
    }))
    await vi.advanceTimersByTimeAsync(200)

    expect(input().value).toBe('launch')
    expect(results().hidden).toBe(true)
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).not.toBe(input())
  })

  it('keeps stale results mounted but inert while a changed query is debouncing', async () => {
    const d = open()
    const stale = insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Alpha launch',
    })
    advanceClock()
    const fresh = insertItem(d, {
      project: 'beta',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Beta deployment',
    })
    await bootApp(d)
    await searchFor('alpha')
    input().focus()
    const listbox = results()
    const staleOption = option(stale)

    type(input(), 'beta')
    expect(results()).toBe(listbox)
    expect(results().hidden).toBe(false)
    expect(results().getAttribute('aria-busy')).toBe('true')
    expect(staleOption?.getAttribute('aria-disabled')).toBe('true')
    input().dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }))
    click(staleOption)
    expect(row(stale)?.dataset['open']).not.toBe('1')

    await vi.advanceTimersByTimeAsync(200)
    expect(results()).toBe(listbox)
    expect(results().hasAttribute('aria-busy')).toBe(false)
    expect(option(fresh)).toBeTruthy()
  })

  it('updates highlights in place when the best results stay in the same order', async () => {
    const d = open()
    const target = insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Alpha beta launch',
    })
    await bootApp(d)
    await searchFor('alpha')
    const before = option(target)
    expect(before?.querySelector('mark')?.textContent).toBe('Alpha')

    type(input(), 'beta')
    await vi.advanceTimersByTimeAsync(200)

    expect(option(target)).toBe(before)
    expect(before?.querySelector('mark')?.textContent).toBe('beta')
  })

  it('restores activation and the active descendant after a rapid query revert', async () => {
    const d = open()
    const target = insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Alpha launch',
    })
    await bootApp(d)
    await searchFor('alpha')
    const active = option(target)!

    type(input(), 'alphax')
    type(input(), 'alpha')

    expect(results().hasAttribute('aria-busy')).toBe(false)
    expect(input().getAttribute('aria-activedescendant')).toBe(active.id)
    click(active)
    await settle()
    expect(row(target)?.dataset['open']).toBe('1')
  })

  it('lets a first query commit when a poll repaint lands inside its debounce window', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Choose the launch window',
    })
    await bootApp(d)

    await vi.advanceTimersByTimeAsync(2900)
    input().focus()
    type(input(), 'launch')
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(30)

    expect(input().value).toBe('launch')
    expect(results().hidden).toBe(false)
    expect(input().getAttribute('aria-expanded')).toBe('true')
  })

  it('opens a query entered before the initial workspace payload arrives', async () => {
    const d = open()
    const target = insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Early search target',
    })
    const bridge = await bootApp(d, { holdFetch: true })

    input().focus()
    type(input(), 'early')
    await vi.advanceTimersByTimeAsync(200)
    expect(results().hidden).toBe(true)

    bridge.releaseFetch()
    await settle()

    expect(option(target)).toBeTruthy()
    expect(results().hidden).toBe(false)
    expect(input().getAttribute('aria-expanded')).toBe('true')
  })

  it('preserves the active result and result DOM across polls', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Launch alpha',
    })
    await bootApp(d)
    await searchFor('launch')
    const activeId = input().getAttribute('aria-activedescendant')!
    const active = document.getElementById(activeId)!
    const activeTarget = active.dataset['searchTarget']

    await pollTick()
    expect(document.getElementById(activeId)).toBe(active)

    advanceClock()
    insertItem(d, {
      project: 'beta',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Launch beta',
    })
    await pollTick()
    const refreshed = document.getElementById(input().getAttribute('aria-activedescendant')!)
    expect(refreshed?.dataset['searchTarget']).toBe(activeTarget)
  })

  it('indexes plan rows, provides a useful empty state, and navigates a plan result to Plans', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Unrelated inbox item',
    })
    advanceClock()
    upsertBoard(d, {
      project: 'beta',
      stream: 'release',
      agent: 'claude',
      title: 'Release readiness',
      rows: [{
        label: 'Deploy canary',
        status: 'tracked',
        note: 'The canary is ready for the first region.',
      }],
    })
    const boardId = listBoards(d)[0]!.id
    await bootApp(d)

    await searchFor('nothing matches this')
    expect(results().hidden).toBe(false)
    expect(results().querySelector('.search-results-empty')?.textContent)
      .toContain('No results for “nothing matches this”')

    await searchFor('canary')
    expect(option(boardId)?.textContent).toContain('Release readiness')
    expect(option(boardId)?.textContent).toContain('Deploy canary')
    expect(option(boardId)?.textContent).toContain('Active plan')

    click(option(boardId))
    await settle()

    expect(document.querySelector('[data-tab="boards"]')?.getAttribute('aria-selected')).toBe('true')
    expect(results().hidden).toBe(true)
    expect(input().value).toBe('')
  })

  it('uses Arrow keys and Enter to activate an indexed result while focus stays in the combobox', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Launch alpha',
    })
    advanceClock()
    insertItem(d, {
      project: 'beta',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Launch beta',
    })
    await bootApp(d)

    await searchFor('launch')
    input().focus()
    input().dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }))

    const activeId = input().getAttribute('aria-activedescendant')
    expect(activeId).toBeTruthy()
    expect(document.getElementById(activeId!)?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(input())
    const activatedTarget = document.getElementById(activeId!)?.dataset['searchTarget']

    input().dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }))
    await settle()

    expect(activatedTarget).toBeTruthy()
    expect(row(activatedTarget!)?.dataset['open']).toBe('1')
    expect(results().hidden).toBe(true)
  })

  it('resets the highlight to the best result when the query changes', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Launch alpha',
    })
    advanceClock()
    insertItem(d, {
      project: 'beta',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Launch beta',
    })
    await bootApp(d)
    await searchFor('launch')
    input().focus()
    const bestTarget = results().querySelector<HTMLElement>('[role="option"]')?.dataset['searchTarget']!
    input().dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }))
    const selectedId = input().getAttribute('aria-activedescendant')!
    const selectedTarget = document.getElementById(selectedId)?.dataset['searchTarget']!
    expect(selectedTarget).not.toBe(bestTarget)

    await searchFor('launc')
    const active = document.getElementById(input().getAttribute('aria-activedescendant')!)
    expect(active).toBe(results().querySelector('[role="option"]'))
    expect(active?.dataset['searchTarget']).toBe(bestTarget)
    input().dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }))
    await settle()

    expect(row(bestTarget)?.dataset['open']).toBe('1')
  })

  it('keeps visual and Enter selection aligned for trim-equivalent query edits', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Launch alpha',
    })
    advanceClock()
    insertItem(d, {
      project: 'beta',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Launch beta',
    })
    await bootApp(d)
    await searchFor('launch')
    input().focus()
    input().dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }))
    const selectedId = input().getAttribute('aria-activedescendant')!
    const selectedTarget = document.getElementById(selectedId)?.dataset['searchTarget']!

    await searchFor('launch ')
    expect(document.getElementById(input().getAttribute('aria-activedescendant')!)?.dataset['searchTarget'])
      .toBe(selectedTarget)
    input().dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }))
    await settle()

    expect(row(selectedTarget)?.dataset['open']).toBe('1')
  })

  it('refreshes query-specific empty text when consecutive queries have no results', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Choose the launch window',
    })
    await bootApp(d)

    await searchFor('first missing query')
    await searchFor('second missing query')

    expect(results().querySelector('.search-results-empty')?.textContent)
      .toContain('No results for “second missing query”')
  })

  it('leaves IME composition keys to the text input without navigating or clearing', async () => {
    const d = open()
    const target = insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Choose the launch window',
    })
    await bootApp(d)
    await searchFor('launch')
    input().focus()

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    input().dispatchEvent(enter)
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    input().dispatchEvent(escape)
    await settle()

    expect(enter.defaultPrevented).toBe(false)
    expect(escape.defaultPrevented).toBe(false)
    expect(input().value).toBe('launch')
    expect(results().hidden).toBe(false)
    expect(row(target)?.dataset['open']).not.toBe('1')
  })
})
