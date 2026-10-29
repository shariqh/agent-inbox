// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, click, expectConsoleError, freshDb, navigateToHash, pollTick,
  row, rowTitles, settle, tabCount, type, useDomTest,
} from './harness.js'

// Dashboard 2.0 phase 0 (#302): the Motion setting and the hidden-page pause.
// The CSS they switch is pinned in test/motion-css.test.ts; jsdom cannot evaluate it.

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  delete (document as unknown as Record<string, unknown>)['hidden']
})

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const MOTION_KEY = 'agent-inbox-motion'

function open(): Database.Database {
  db = freshDb()
  return db
}

function motionSelect(): HTMLSelectElement {
  const select = document.querySelector<HTMLSelectElement>('#setup select[aria-label="Motion"]')
  if (!select) throw new Error('motion setting not rendered')
  return select
}

async function chooseMotion(value: string): Promise<void> {
  if (document.getElementById('setup')?.hidden) click(document.getElementById('gear'))
  const select = motionSelect()
  select.focus()
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
}

function setPageHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('Motion setting (#302)', () => {
  it('defaults to Full and offers Full and Calm', async () => {
    await bootApp(open())
    click(document.getElementById('gear'))

    expect(document.documentElement.dataset.motion).toBe('full')
    expect(motionSelect().value).toBe('full')
    expect([...motionSelect().options].map((option) => [option.value, option.textContent]))
      .toEqual([['full', 'Full'], ['calm', 'Calm']])
  })

  it('restores a saved Calm choice on boot and ignores an unknown value', async () => {
    localStorage.setItem(MOTION_KEY, 'calm')
    await bootApp(open())
    expect(document.documentElement.dataset.motion).toBe('calm')

    vi.resetModules()
    localStorage.setItem(MOTION_KEY, 'wild')
    await bootApp(db!)
    expect(document.documentElement.dataset.motion).toBe('full')
  })

  it('saves a choice and repaints through forceRender past an unrelated draft, with attention unchanged', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'first question' })
    await bootApp(d)
    click(row(id))
    await settle()
    type(answerInput(id), 'half-written answer')
    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'draft-gated arrival' })
    await pollTick()
    expect(rowTitles(), 'the draft must hold the poll, or this test proves nothing').not.toContain('draft-gated arrival')
    const badge = badgeCount()
    const needsYou = tabCount('needsYou')

    await chooseMotion('calm')

    expect(localStorage.getItem(MOTION_KEY)).toBe('calm')
    expect(document.documentElement.dataset.motion).toBe('calm')
    expect(rowTitles()).toContain('draft-gated arrival')
    expect(answerInput(id)?.value).toBe('half-written answer')
    expect(document.activeElement).toBe(motionSelect())
    expect(badgeCount()).toBe(badge)
    expect(tabCount('needsYou')).toBe(needsYou)

    await chooseMotion('full')
    expect(localStorage.getItem(MOTION_KEY)).toBe('full')
    expect(document.documentElement.dataset.motion).toBe('full')
    expect(badgeCount()).toBe(badge)
  })

  it('keeps the current choice when it cannot be saved', async () => {
    await bootApp(open())
    expectConsoleError(/Motion setting could not be saved/)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota exceeded')
    })

    await chooseMotion('calm')

    expect(motionSelect().value).toBe('full')
    expect(document.documentElement.dataset.motion).toBe('full')
    expect(localStorage.getItem(MOTION_KEY)).toBeNull()
    expect(document.getElementById('status')?.textContent).toBe('motion setting not saved')
  })
})

describe('hidden-page pause and reduced-motion scrolling (#302)', () => {
  it('marks the page hidden while document.hidden, and clears it when shown', async () => {
    await bootApp(open())
    expect('pageHidden' in document.documentElement.dataset).toBe(false)

    setPageHidden(true)
    expect(document.documentElement.dataset.pageHidden).toBe('')

    setPageHidden(false)
    expect('pageHidden' in document.documentElement.dataset).toBe(false)
  })

  it('scrolls to a deep-linked item instantly under the OS reduced-motion setting', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'linked question' })
    await bootApp(d)
    const reveal = vi.spyOn(Element.prototype, 'scrollIntoView')

    navigateToHash(`#item/${id}`)
    await settle()
    expect(reveal).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'center' })

    ;(window.matchMedia('(prefers-reduced-motion: reduce)') as { matches: boolean }).matches = true
    reveal.mockClear()
    navigateToHash('')
    await settle()
    navigateToHash(`#item/${id}`)
    await settle()
    expect(reveal).toHaveBeenLastCalledWith({ behavior: 'auto', block: 'center' })
  })
})
