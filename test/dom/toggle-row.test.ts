// @vitest-environment jsdom
// test/dom/toggle-row.test.ts
// Needs-you inspector selection and the write path behind it: C2, C3, C4 (commit 21b16d0)
// and I5 (commit 4f12144), asserted through real clicks instead of source text.
//
//   C2 — a REFUSED "Change answer" wrote the prefill draft before the POST, so the
//        draft had no input to live in and nothing could clear it: frozen viewer.
//   C3 — a failed write discarded what the human typed, and #status's reason was
//        wiped by the next successful poll ≤3s later. Silent data loss.
//   C4 — nothing checked the response STATUS: a 500 returns text, res.json() throws,
//        the .catch handed the caller {} and every caller read that as success.
//   I5 — a staged ★ flushed from `beforeunload` used a plain fetch, routinely
//        cancelled during teardown: the row said "Sent" and nothing was written.
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listItems, markReplySeen, replyItem } from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, click, collapseRow, expectConsoleError, freshDb,
  pollTick, row, rowTitles, rows, sendButton, settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

describe('Needs-you row selection is idempotent and single-open', () => {
  it('opens the clicked row and closes whatever was open', async () => {
    const d = open()
    const a = insertItem(d, { ...AGENT, kind: 'question', title: 'first' })
    advanceClock()
    const b = insertItem(d, { ...AGENT, kind: 'question', title: 'second' })
    await bootApp(d)

    click(row(a))
    await settle()
    expect(row(a)?.dataset['open']).toBe('1')
    expect(document.querySelectorAll('.nrow-card').length).toBe(1)

    click(row(b))
    await settle()
    expect(row(a)?.hasAttribute('data-open')).toBe(false)
    expect(row(b)?.dataset['open']).toBe('1')
    expect(document.querySelectorAll('.nrow-card').length).toBe(1)
  })

  it('keeps the exact card, draft, scroll, and focus on repeated pointer activation', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'stable selection' })
    await bootApp(d)

    click(row(id))
    await settle()
    const card = row(id)!.querySelector<HTMLElement>('.nrow-card')!
    const input = answerInput(id)!
    type(input, 'unfinished answer')
    card.scrollTop = 180
    input.focus()

    const down = new window.MouseEvent('mousedown', {
      button: 0,
      bubbles: true,
      cancelable: true,
    })
    row(id)!.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    click(row(id))
    await settle()

    expect(row(id)?.dataset['open']).toBe('1')
    expect(row(id)?.querySelector('.nrow-card')).toBe(card)
    expect(answerInput(id)).toBe(input)
    expect(answerInput(id)?.value).toBe('unfinished answer')
    expect(card.scrollTop).toBe(180)
    expect(document.activeElement).toBe(input)
  })

  it('reselects an already-open row without remounting it after roving selection moved away', async () => {
    const d = open()
    const first = insertItem(d, { ...AGENT, kind: 'question', title: 'first' })
    advanceClock()
    const second = insertItem(d, { ...AGENT, kind: 'question', title: 'second' })
    await bootApp(d)

    click(row(first))
    await settle()
    const card = row(first)!.querySelector('.nrow-card')
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'j', bubbles: true }))
    await settle()
    expect(row(first)?.classList.contains('selected')).toBe(false)
    expect(document.activeElement).not.toBe(row(first))

    const down = new window.MouseEvent('mousedown', {
      button: 0,
      bubbles: true,
      cancelable: true,
    })
    row(first)!.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(false)
    click(row(first))
    await settle()

    expect(row(first)?.classList.contains('selected')).toBe(true)
    expect(row(first)?.querySelector('.nrow-card')).toBe(card)
    expect(document.activeElement).toBe(row(first))

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'e', bubbles: true }))
    await settle()
    expect(listItems(d).find((item) => item.id === first)?.status).toBe('resolved')
    expect(listItems(d).find((item) => item.id === second)?.status).toBe('open')
  })

  it('keeps the real multiline editor mounted and focused when its open row is reselected', async () => {
    const d = open()
    const first = insertItem(d, { ...AGENT, kind: 'question', title: 'first' })
    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'second' })
    await bootApp(d)

    click(row(first))
    await settle()
    const card = row(first)!.querySelector('.nrow-card')!
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'j', bubbles: true }))
    await settle()
    expect(row(first)?.classList.contains('selected')).toBe(false)

    const editor = answerInput(first)!
    editor.focus()
    type(editor, 'line one\nline two')
    const down = new window.MouseEvent('mousedown', {
      button: 0,
      bubbles: true,
      cancelable: true,
    })
    row(first)!.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    click(row(first))
    await settle()

    expect(document.activeElement).toBe(editor)
    expect(editor.value).toBe('line one\nline two')
    expect(row(first)?.classList.contains('selected')).toBe(true)
    expect(row(first)?.querySelector('.nrow-card')).toBe(card)
    expect(answerInput(first)).toBe(editor)
  })

  it('keeps the exact card mounted when Enter reactivates the selected row', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'keyboard selection' })
    await bootApp(d)

    const firstRow = row(id)!
    firstRow.focus()
    firstRow.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }))
    await settle()
    const card = row(id)!.querySelector('.nrow-card')
    row(id)!.focus()

    row(id)!.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }))
    await settle()

    expect(row(id)?.dataset['open']).toBe('1')
    expect(row(id)?.querySelector('.nrow-card')).toBe(card)
    expect(document.activeElement).toBe(row(id))
  })

  it('explicitly collapses with Escape and restores row focus', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'collapse me' })
    await bootApp(d)

    click(row(id))
    await settle()
    expect(document.activeElement).toBe(row(id)?.querySelector('.nrow-card'))

    await collapseRow(id)

    expect(row(id)?.hasAttribute('data-open')).toBe(false)
    expect(row(id)?.querySelector('.nrow-card')).toBeNull()
    expect(document.activeElement).toBe(row(id))
  })
})

describe('I5 · every write must survive page teardown', () => {
  it('the answer POST carries keepalive: true', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    const bridge = await bootApp(d)

    click(row(id))
    await settle()
    type(answerInput(), 'yes, ship it')
    click(sendButton())
    await settle()

    const post = bridge.posts.find((p) => p.url.endsWith('/reply'))
    expect(post, 'no reply POST was made').toBeTruthy()
    expect(post?.init?.keepalive).toBe(true)
    expect(listItems(d)[0]?.reply).toBe('yes, ship it')
  })
})

describe('C4 · a non-2xx write must not read as success', () => {
  it('surfaces "write failed (500)" instead of silently swallowing it', async () => {
    // read #status after settle() ONLY — the next successful poll clears it (load()
    // ends with status.textContent = ''), so pollTick() here would read ''.
    expectConsoleError(/HTTP 500/)
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    const bridge = await bootApp(d)
    bridge.failPostsWith(500)

    click(row(id))
    await settle()
    type(answerInput(), 'yes, ship it')
    click(sendButton())
    await settle()

    expect(document.getElementById('status')?.textContent).toBe('write failed (500)')
    expect(listItems(d)[0]?.reply, 'nothing may have been written').toBeNull()
  })
})

describe('C3 · a failed write must not discard the typed answer', () => {
  it('the draft survives a collapse and re-expand', async () => {
    expectConsoleError(/HTTP 500/)
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    const bridge = await bootApp(d)
    bridge.failPostsWith(500)

    click(row(id))
    await settle()
    type(answerInput(), 'yes, ship it')
    click(sendButton())
    await settle()

    // the reason parks beside Send — never the auto-clearing status line
    const err = document.querySelector<HTMLElement>('.nrow-card .write-error')
    expect(err?.hidden).toBe(false)
    expect(err?.textContent).toBe('Not sent — nothing was lost; press Send to retry.')

    // Collapse and RE-EXPAND before asserting. With the row open the poll is suspended
    // and the input node keeps its value either way, so a naive assertion passes on the
    // buggy code too; only a rebuild-from-module-state proves the draft was kept.
    await collapseRow(id)
    expect(document.querySelectorAll('.nrow-card').length).toBe(0)
    click(row(id))
    await settle()

    expect(answerInput()?.value).toBe('yes, ship it')
    expect(listItems(d)[0]?.reply).toBeNull()
  })
})

// The reply CONTEXT in these fixtures is load-bearing, not decoration — without it
// the refusal test below passes on the pre-fix tree too, which is exactly how the
// first version of it shipped as a non-discriminating test.
//
// `suspendState()` merges draftReplies, draftReplyContexts and rowDrafts into ONE
// object keyed by id. changeAnswer writes BOTH maps under the same item id, so with
// an empty reply_context the later spread parks `''` over the reply draft and the
// merged view reads blank: the orphan exists in module state but suspends nothing.
// Give the answer a context and the pre-fix orphan is non-empty, which is the C2
// freeze as the commit describes it.
const ANSWER = 'yes'
const ANSWER_CONTEXT = 'because CI is green on the release branch'

describe('C2 · a REFUSED change-answer must not freeze the viewer', () => {
  it('writes no draft at all, so nothing suspends a poll that no input could un-suspend', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    replyItem(d, id, ANSWER, ANSWER_CONTEXT)
    advanceClock()
    markReplySeen(d, id, listItems(d).find((i) => i.id === id)!.replied_at) // the store will now legitimately refuse a blank-out: 200 + {ok:false}
    await bootApp(d)

    // the precondition is itself the I4 fix — an answered + picked-up open question
    // must still render somewhere. Keep the two adjacent so the coupling is visible.
    expect(rowTitles()).toEqual(['ship it?'])

    click(row(id))
    await settle()
    click(buttonLabelled('Change answer', row(id)!))
    await settle()

    // `?.textContent` on a missing node is undefined, and `expect(undefined).not.toBe('')`
    // passes — so match the copy instead of asserting "not empty".
    expect(document.querySelector('.refusal-msg')?.textContent ?? '').toMatch(/Picked up/)
    expect(listItems(d)[0]?.reply, 'the picked-up answer must survive the refusal').toBe(ANSWER)

    await collapseRow(id) // the rejected reply draft remains the only suspend reason

    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'SECOND question' })
    await pollTick()

    // The orphan named directly, in the two halves that make it an orphan:
    // the refusal built no answer surface, so there is no input anywhere that
    // could hold or clear a draft…
    expect(document.querySelectorAll('.reply-input').length,
      'a refused change-answer leaves the item answered, so no answer surface is built').toBe(0)
    // …and #pauseHint is the app's own report of suspendReason(). Pre-fix this reads
    // "paused — updating when you're done" forever: a viewer paused on a draft with
    // no home. THIS is the assertion that discriminates the C2 hunk.
    expect(document.getElementById('pauseHint')?.textContent,
      'the refusal must leave nothing behind that suspends the poll').toBe('')
    // and the human-visible consequence of that freeze
    expect(rowTitles()).toContain('SECOND question')
    expect(rows().length).toBe(2)
  })

  // The other direction. This does NOT discriminate commit 21b16d0 — both trees
  // write the prefill on the accepted path, only the ORDER differs — it is here so
  // that "fixing" C2 by deleting the prefill outright cannot pass.
  it('an ACCEPTED change-answer brings the answer surface back holding the old reply', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    replyItem(d, id, ANSWER, ANSWER_CONTEXT) // never picked up → the blank-out is allowed
    await bootApp(d)

    click(row(id))
    await settle()
    click(buttonLabelled('Change answer', row(id)!))
    await settle()

    expect(listItems(d)[0]?.reply, 'the blank-out landed').toBeNull()
    expect(document.querySelector('.refusal-msg')?.textContent ?? '').toBe('')
    expect(answerInput(id)?.value, 'the answer comes back prefilled with what it was').toBe(ANSWER)
    expect(document.querySelector<HTMLInputElement>(`.nrow[data-card-id="${id}"] .reply-context-input`)?.value)
      .toBe(ANSWER_CONTEXT)
  })
})
