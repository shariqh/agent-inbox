// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { advanceBoardRow, getBoard, getItem, insertItem, upsertBoard } from '../../src/store.js'
import {
  answerInput, bootApp, click, freshDb, pollTick, row, settle, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open() {
  db = freshDb()
  const id = insertItem(db, {
    project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question',
    title: 'Choose the rollout',
    options: [{ label: 'Canary', recommended: true }, { label: 'Hold' }],
  })
  return { db, id }
}

function press(key: string, target: EventTarget = document.activeElement ?? document.body, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
  target.dispatchEvent(event)
  return event
}

describe('keyboard-first workspace', () => {
  it('shows key tiles and uses G sequences for workspace navigation', async () => {
    const { db: d } = open()
    await bootApp(d)

    expect(document.getElementById('keyboardHelp')?.getAttribute('data-shortcut')).toBe('?')
    expect(document.getElementById('keyboardHints')?.getAttribute('data-shortcut')).toBe('F')
    const destinations = [
      ['i', 'needsYou', 'G I'], ['p', 'boards', 'G P'], ['n', 'notes', 'G N'],
      ['h', 'done', 'G H'], ['d', 'dashboard', 'G D'],
    ] as const
    for (const [key, id, label] of destinations) {
      expect(document.querySelector(`[data-tab="${id}"]`)?.getAttribute('data-shortcut')).toBe(label)
      press('g')
      press(key)
      expect(document.getElementById(id)?.hidden).toBe(false)
    }
    press('g')
    press('s')
    expect(document.getElementById('setup')?.hidden).toBe(false)
    press('g')
    press('a')
    expect(document.activeElement).toBe(document.getElementById('agentSelect'))
  })

  it('does not steal hint, help, or navigation letters from editable controls', async () => {
    const { db: d } = open()
    await bootApp(d)
    const search = document.getElementById('search') as HTMLInputElement
    search.focus()
    for (const key of ['f', '?', 'g', 'i']) expect(press(key).defaultPrevented).toBe(false)
    expect(document.getElementById('dashboard')?.hidden).toBe(false)
    expect(document.getElementById('keyboardbox')?.hidden).toBe(true)
    expect(document.querySelector('.key-hints-layer')).toBeNull()

    const select = document.getElementById('agentSelect')!
    select.focus()
    for (const key of ['f', '?', 'g', 'i']) expect(press(key).defaultPrevented).toBe(false)

    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    editor.tabIndex = 0
    document.body.appendChild(editor)
    editor.focus()
    for (const key of ['f', '?', 'g', 'i']) expect(press(key).defaultPrevented).toBe(false)
    expect(document.getElementById('dashboard')?.hidden).toBe(false)
  })

  it('lands Inbox navigation on the queue so Enter and R work immediately', async () => {
    const { db: d, id } = open()
    await bootApp(d)
    press('g')
    press('i')
    expect(document.activeElement).toBe(row(id))
    press('Enter')
    await settle()
    expect(row(id)?.getAttribute('aria-expanded')).toBe('true')
    press('r')
    expect(document.activeElement).toBe(answerInput(id))
  })

  it('returns a go-to destination to the top instead of preserving a clipped page', async () => {
    const { db: d } = open()
    await bootApp(d)
    const original = Object.getOwnPropertyDescriptor(window, 'scrollY')!
    let offset = 300
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => offset })
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => { offset = 0 })
    try {
      press('g')
      press('n')
      expect(window.scrollY).toBe(0)
      expect(document.activeElement).toBe(document.getElementById('notes'))
    } finally {
      Object.defineProperty(window, 'scrollY', original)
      scroll.mockRestore()
    }
  })

  it('pins real plan controls to their owner and advances the hint version with a new action', async () => {
    const { db: d } = open()
    const scope = { project: 'alpha', agent: 'copilot', stream: 'main' }
    const action = {
      label: 'Approval', status: 'blocked' as const, note: 'A preview needs approval.',
      next_step: 'Approve this preview', action_owner: 'approval' as const,
      impact: 'Changes the preview only.',
      options: [{ label: 'Approve' }, { label: 'Hold' }],
    }
    upsertBoard(d, { ...scope, title: 'Keyboard plan', rows: [action] })
    const board = getBoard(d, scope.project, 'Keyboard plan')!
    const initial = board.rows[0]!
    await bootApp(d)
    await showInbox()
    const owner = `row:${initial.id}`
    const selector = `.nrow[data-key-hint-owner="${owner}"]`
    click(document.querySelector(selector))
    await settle()
    const before = document.querySelector(`${selector} .row-answer`)!
    expect(before.getAttribute('data-key-hint-owner')).toBe(owner)
    expect(before.getAttribute('data-key-hint-version')).toBe(`${board.revision}:${initial.revision}`)

    advanceBoardRow(d, {
      ...scope, ...action, title: 'Keyboard plan',
      expectedBoardVersion: board.revision, expectedRevision: initial.revision,
    })
    await pollTick()
    const advanced = getBoard(d, scope.project, 'Keyboard plan')!
    const after = document.querySelector(`${selector} .row-answer`)!
    expect(after.getAttribute('data-key-hint-version')).toBe(`${advanced.revision}:${advanced.rows[0]!.revision}`)
    expect(after.getAttribute('data-key-hint-version')).not.toBe(before.getAttribute('data-key-hint-version'))
    after.querySelector<HTMLTextAreaElement>('textarea')!.focus()
    press('Escape')
    after.closest<HTMLElement>('.nrow-card')!.focus()
    press('2')
    await settle()
    expect(getBoard(d, scope.project, 'Keyboard plan')!.rows[0]!.annotation).toBe('Hold')
  })

  it('cancels G sequences without dismissing or collapsing the current item', async () => {
    const { db: d, id } = open()
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    const card = row(id)!.querySelector<HTMLElement>('.nrow-card')!
    card.focus()
    press('g')
    press('Escape')
    expect(row(id)?.getAttribute('aria-expanded')).toBe('true')
    press('g')
    press('x')
    await vi.advanceTimersByTimeAsync(5_100)
    await settle()
    expect(getItem(d, id)?.status).toBe('open')
    expect(row(id)?.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps shortcut help focused and restores its caller after a poll', async () => {
    const { db: d, id } = open()
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    row(id)!.querySelector<HTMLElement>('.nrow-card')!.focus()
    press('?')
    const box = document.getElementById('keyboardbox')!
    const panel = box.querySelector<HTMLElement>('.keyboard-panel')!
    expect(box.hidden).toBe(false)
    expect(panel.contains(document.activeElement)).toBe(true)
    expect(panel.textContent).toContain('Show keys')
    expect(panel.textContent).toContain('typing')

    const controls = [...panel.querySelectorAll<HTMLElement>('button, input, a[href]')]
    const first = controls[0]!
    const last = controls.at(-1)!
    last.focus()
    press('Tab')
    expect(document.activeElement).toBe(first)
    press('Tab', first, { shiftKey: true })
    expect(document.activeElement).toBe(last)
    press('x')
    press('1')
    await pollTick()
    expect(box.hidden).toBe(false)
    expect(getItem(d, id)?.reply).toBeNull()
    expect(getItem(d, id)?.status).toBe('open')

    press('Escape')
    expect(box.hidden).toBe(true)
    expect(row(id)?.contains(document.activeElement)).toBe(true)
  })

  it('does not send answers during composition or auto-repeat', async () => {
    const { db: d, id } = open()
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    const card = row(id)!.querySelector<HTMLElement>('.nrow-card')!
    card.focus()
    press('1', card, { isComposing: true })
    press('1', card, { repeat: true })
    await settle()
    expect(getItem(d, id)?.reply).toBeNull()

    const reply = answerInput(id)!
    reply.focus()
    type(reply, 'Keep this draft')
    press('Enter', reply, { ctrlKey: true, isComposing: true })
    press('Enter', reply, { ctrlKey: true, repeat: true })
    await settle()
    expect(getItem(d, id)?.reply).toBeNull()
    expect(reply.value).toBe('Keep this draft')
  })

  it('shows action keycaps without changing answer text and supports a focused choice', async () => {
    const { db: d, id } = open()
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    const choices = [...row(id)!.querySelectorAll<HTMLButtonElement>('.opt-pill')]
    expect(choices[0]?.getAttribute('data-shortcut')).toBe('1')
    expect(choices[1]?.getAttribute('data-shortcut')).toBe('2')
    expect(choices[1]?.textContent).toBe('Hold')
    choices[1]!.focus()
    press('2')
    await settle()
    expect(getItem(d, id)?.reply).toBe('Hold')
  })

  it('chooses a sibling option by its key without requiring focus on that button', async () => {
    const { db: d, id } = open()
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    row(id)!.querySelector<HTMLButtonElement>('.opt-pill')!.focus()
    press('2')
    await settle()
    expect(getItem(d, id)?.reply).toBe('Hold')
  })

  it('focuses the open reply with R and retains multiline submit behavior', async () => {
    const { db: d, id } = open()
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    const card = row(id)!.querySelector<HTMLElement>('.nrow-card')!
    card.focus()
    press('r')
    const reply = answerInput(id)!
    expect(document.activeElement).toBe(reply)
    type(reply, 'Use a canary\nThen expand')
    expect(press('Enter', reply).defaultPrevented).toBe(false)
    await settle()
    expect(getItem(d, id)?.reply).toBeNull()
    press('Enter', reply, { ctrlKey: true })
    await settle()
    expect(getItem(d, id)?.reply).toBe('Use a canary\nThen expand')
  })

  it('does not route navigation or destructive shortcuts behind another dialog', async () => {
    const { db: d, id } = open()
    await bootApp(d)
    await showInbox()
    const handoffs = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Handoffs')!
    click(handoffs)
    const panel = document.querySelector<HTMLElement>('#relaybox .relay-panel')!
    panel.tabIndex = -1
    panel.focus()
    press('g')
    press('s')
    press('x')
    press('e')
    await vi.advanceTimersByTimeAsync(5_100)
    await settle()
    expect(document.getElementById('relaybox')?.hidden).toBe(false)
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(getItem(d, id)?.status).toBe('open')
  })

})
