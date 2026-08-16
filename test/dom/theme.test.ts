// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import {
  answerInput, bootApp, click, expectConsoleError, freshDb, row, setSystemDark, settle, type,
  useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

function themeChoice(value: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`input[name="theme-preference"][value="${value}"]`)
}

describe('viewer theme controls', () => {
  it('defaults to Light and exposes an accessible three-choice Settings control', async () => {
    await bootApp(open())
    click(document.getElementById('gear'))

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.themePreference).toBe('light')
    expect(document.querySelector('.theme-picker fieldset')?.getAttribute('aria-label')).toBe('Appearance')
    expect([...document.querySelectorAll<HTMLInputElement>('input[name="theme-preference"]')].map((input) => input.value))
      .toEqual(['light', 'dark', 'system'])
    expect(themeChoice('light')?.checked).toBe(true)
  })

  it('persists pointer-selected Dark and applies it immediately', async () => {
    await bootApp(open())
    click(document.getElementById('gear'))
    click(themeChoice('dark'))

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.themePreference).toBe('dark')
    expect(localStorage.getItem('agent-inbox-theme')).toBe('dark')
  })

  it('restores a saved Dark preference during boot', async () => {
    localStorage.setItem('agent-inbox-theme', 'dark')
    await bootApp(open())

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.themePreference).toBe('dark')
  })

  it('restores the checked choice when persistence fails', async () => {
    await bootApp(open())
    click(document.getElementById('gear'))
    expectConsoleError(/Theme preference could not be saved/)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota exceeded')
    })

    click(themeChoice('dark'))

    expect(themeChoice('light')?.checked).toBe(true)
    expect(themeChoice('dark')?.checked).toBe(false)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('tracks live OS changes in System and ignores them in explicit Dark', async () => {
    await bootApp(open())
    click(document.getElementById('gear'))
    click(themeChoice('system'))
    setSystemDark(true)
    await settle()
    expect(document.documentElement.dataset.theme).toBe('dark')

    setSystemDark(false)
    await settle()
    expect(document.documentElement.dataset.theme).toBe('light')

    click(themeChoice('dark'))
    setSystemDark(false)
    await settle()
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('applies System changes without remounting an active response draft', async () => {
    const d = open()
    const id = insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Choose the release window',
    })
    await bootApp(d)
    click(document.getElementById('gear'))
    click(themeChoice('system'))
    click(document.getElementById('gear'))
    click(row(id))

    const editor = answerInput(id)!
    Object.defineProperty(editor, 'scrollHeight', { configurable: true, value: 240 })
    editor.focus()
    type(editor, 'Keep this draft intact\nacross multiple lines')
    expect(editor.style.height).toBe('160px')
    expect(editor.style.overflowY).toBe('auto')

    setSystemDark(true)

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(answerInput(id)).toBe(editor)
    expect(document.activeElement).toBe(editor)
    expect(editor.value).toBe('Keep this draft intact\nacross multiple lines')

    Object.defineProperty(editor, 'scrollHeight', { configurable: true, value: 32 })
    type(editor, '')
    await settle()

    const resumedEditor = answerInput(id)
    expect(resumedEditor).not.toBe(editor)
    expect(resumedEditor?.value).toBe('')
    expect(document.activeElement).toBe(resumedEditor)
  })
})
