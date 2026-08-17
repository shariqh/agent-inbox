// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listBoards, listItems, upsertBoard } from '../../src/store.js'
import {
  answerInput, attachStylesheet, bootApp, click, freshDb, row, settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

describe('multiline human responses', () => {
  it('keeps a question reply and context structured through submit, storage, and rendering', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'How should this roll out?' })
    await bootApp(d)
    attachStylesheet()

    click(row(id))
    await settle()

    const reply = answerInput(id)
    const context = row(id)?.querySelector<HTMLTextAreaElement>('.reply-context-input') ?? null
    expect(reply).toBeInstanceOf(HTMLTextAreaElement)
    expect(context).toBeInstanceOf(HTMLTextAreaElement)

    const structuredReply = 'Use a canary:\n\n1. Deploy to 10%\n2. Watch errors\n3. Continue'
    const structuredContext = 'Checks:\n- latency\n- error rate'
    type(reply, structuredReply)
    type(context, structuredContext)

    const enter = reply!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }))
    expect(enter, 'plain Enter must remain the textarea newline action').toBe(true)
    await settle()
    expect(listItems(d)[0]!.reply, 'plain Enter must not submit').toBeNull()

    const shortcut = context!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }))
    expect(shortcut, 'the submit shortcut must suppress an extra newline').toBe(false)
    await settle()

    const stored = listItems(d)[0]!
    expect(stored.reply).toBe(structuredReply)
    expect(stored.reply_context).toBe(structuredContext)
    expect(row(id)?.querySelector('.reply-block')?.textContent).toContain(structuredReply)

    const rendered = row(id)?.querySelector<HTMLElement>('.reply-block')
    expect(getComputedStyle(rendered!).whiteSpace).toBe('pre-wrap')
    expect(getComputedStyle(rendered!).overflowWrap).toBe('anywhere')
  })

  it('submits a structured board-row response only on Cmd/Ctrl+Enter', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Release',
      rows: [{ label: 'Approval', status: 'blocked', note: 'Choose the rollout.' }],
    })
    const rowId = listBoards(d)[0]!.rows[0]!.id
    await bootApp(d)

    click(row(rowId))
    await settle()

    const editor = answerInput(rowId)
    expect(editor).toBeInstanceOf(HTMLTextAreaElement)
    const structured = 'Proceed with safeguards:\n\n- keep rollback ready\n- pause on elevated errors'
    type(editor, structured)

    editor!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
    expect(listBoards(d)[0]!.rows[0]!.annotation).toBeNull()

    editor!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }))
    await settle()

    expect(listBoards(d)[0]!.rows[0]!.annotation).toBe(structured)
    expect(row(rowId)?.querySelector('.annotation')?.textContent).toContain(structured)
  })

  it('grows response editors to a fixed cap and scrolls beyond it', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Provide a checklist' })
    await bootApp(d)
    attachStylesheet()

    click(row(id))
    await settle()

    const editor = answerInput(id)!
    Object.defineProperty(editor, 'scrollHeight', { value: 320, configurable: true })
    type(editor, Array.from({ length: 20 }, (_, i) => `Step ${i + 1}`).join('\n'))

    const style = getComputedStyle(editor)
    expect(style.maxHeight).toBe('160px')
    expect(style.resize).toBe('none')
    expect(editor.style.height).toBe('160px')
    expect(editor.style.overflowY).toBe('auto')
  })
})
