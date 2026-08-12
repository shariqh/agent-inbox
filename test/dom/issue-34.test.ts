// @vitest-environment jsdom
// test/dom/issue-34.test.ts
// Chat-recorded answers are already picked up by definition. The viewer must
// preserve that receipt while making a non-destructive inbox correction possible.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import {
  answerItem,
  insertItem,
  listItems,
  resolveItem,
} from '../../src/store.js'
import {
  answerInput,
  bootApp,
  buttonLabelled,
  click,
  freshDb,
  pollTick,
  row,
  sendButton,
  settle,
  type,
  useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

describe('issue #34 · correcting a chat-recorded answer', () => {
  it('prefills a safe correction surface and sends the revision as a new inbox answer', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'which database?',
      options: [{ label: 'SQLite' }, { label: 'Postgres' }],
    })
    expect(answerItem(d, id, 'SQLite', 'keep operations simple')).toEqual({ ok: true })
    await bootApp(d)

    click(row(id))
    await settle()

    const card = row(id)!
    expect(card.querySelector('.reply-block')?.textContent).toContain('SQLite')
    expect(card.querySelector('.reply-source')?.textContent).toBe('via chat')
    expect(card.querySelector('.pickup')?.textContent).toBe('With the agent')
    expect(card.querySelector('.pickup.awaiting')).toBeNull()
    expect(answerInput(id)?.value).toBe('SQLite')
    expect(card.querySelector<HTMLInputElement>('.reply-context-input')?.value)
      .toBe('keep operations simple')
    expect(buttonLabelled('Change answer', card)).toBeNull()

    type(answerInput(id), 'Postgres')
    click(sendButton(id))
    await settle()

    const corrected = listItems(d).find((item) => item.id === id)!
    expect(corrected).toMatchObject({
      reply: 'Postgres',
      reply_context: 'keep operations simple',
      reply_source: 'inbox',
      reply_seen_at: null,
    })
    expect(answerItem(d, id, 'stale chat answer')).toMatchObject({
      ok: false,
      reason: 'unread_inbox_answer',
      reply: 'Postgres',
    })
    expect(row(id)?.querySelector('.reply-source')).toBeNull()
    expect(row(id)?.querySelector('.pickup')?.textContent).toBe('Waiting for the agent')
  })

  it('preserves chat context when correcting with a keyboard option', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'which database?',
      options: [{ label: 'SQLite' }, { label: 'Postgres' }],
    })
    expect(answerItem(d, id, 'SQLite', 'keep operations simple')).toEqual({ ok: true })
    await bootApp(d)

    click(row(id))
    await settle()
    click(row(id))
    await settle()
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: '2', bubbles: true }))
    await settle()

    expect(listItems(d).find((item) => item.id === id)).toMatchObject({
      reply: 'Postgres',
      reply_context: 'keep operations simple',
      reply_source: 'inbox',
    })
  })

  it('preserves chat context when correcting with a disposition', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship now?' })
    expect(answerItem(d, id, 'Ship', 'only after the canary')).toEqual({ ok: true })
    await bootApp(d)

    click(row(id))
    await settle()
    click(buttonLabelled('Decline', row(id)!))
    await settle()

    expect(listItems(d).find((item) => item.id === id)).toMatchObject({
      reply_kind: 'decline',
      reply_context: 'only after the canary',
      reply_source: 'inbox',
    })
  })

  it('does not steal focus back after the human leaves an untouched prefill', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'which database?' })
    expect(answerItem(d, id, 'SQLite', 'keep operations simple')).toEqual({ ok: true })
    await bootApp(d)

    click(row(id))
    await settle()
    answerInput(id)?.focus()
    answerInput(id)?.blur()
    await pollTick()
    await settle()

    expect(document.activeElement?.classList.contains('reply-input')).toBe(false)
  })

  it('does not steal focus back after the human clears a prefilled draft', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'which database?' })
    expect(answerItem(d, id, 'SQLite', 'keep operations simple')).toEqual({ ok: true })
    await bootApp(d)

    click(row(id))
    await settle()
    answerInput(id)?.focus()
    type(answerInput(id), '')
    answerInput(id)?.blur()
    await pollTick()
    await settle()

    expect(document.activeElement?.classList.contains('reply-input')).toBe(false)
  })
})

describe('issue #34 · resolved answer receipt', () => {
  it('keeps the chat answer and provenance visible on the History card without pickup copy', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'which database?' })
    expect(answerItem(d, id, 'SQLite', 'keep operations simple')).toEqual({ ok: true })
    resolveItem(d, id)
    await bootApp(d)

    const card = document.querySelector('#done .card')
    expect(card?.querySelector('.reply-block')?.textContent).toContain('SQLite')
    expect(card?.querySelector('.reply-context')?.textContent).toContain('keep operations simple')
    expect(card?.querySelector('.reply-source')?.textContent).toBe('via chat')
    expect(card?.querySelector('.pickup')).toBeNull()
  })
})
