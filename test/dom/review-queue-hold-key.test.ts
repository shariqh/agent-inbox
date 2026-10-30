// @vitest-environment jsdom
// Issue #407, the `t` door: held for a response the deck would ask for again,
// with the reason in the Inbox header. Its own file because jsdom keeps every
// boot's document listeners, so only a file's first page may answer a key.
import { afterEach, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, upsertBoard } from '../../src/store.js'
import { answerInput, bootApp, buttonLabelled, click, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

it('holds the Review queue on `t`, says why, and shows the response', async () => {
  db = freshDb()
  upsertBoard(db, {
    project: 'alpha', stream: 'main', agent: 'copilot', title: 'Launch plan',
    rows: [{
      label: 'Approve launch', status: 'blocked', note: 'Choose now.', next_step: 'Approve it.',
      action_owner: 'approval', impact: 'Ships.', options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
    }],
  })
  const r = getBoard(db, 'alpha', 'Launch plan')!.rows[0]!
  localStorage.setItem('agent-inbox-drafts-v1', JSON.stringify({
    v: 1,
    entries: {
      [`row-recovery:${r.id}:${r.revision}`]: {
        savedAt: Date.now() - 1000,
        draft: {
          type: 'row-recovery', rowId: r.id, revision: r.revision, actionVersion: r.action_version,
          text: 'Approve as written.', kind: 'answer', boardTitle: 'Launch plan', label: 'Approve launch',
          context: '', setAside: false, reason: '',
        },
      },
    },
  }))
  await bootApp(db)

  document.body.focus()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }))
  await settle()
  expect(document.getElementById('lightbox')!.hidden).toBe(true)
  expect(document.querySelector('.tab[data-tab="needsYou"]')?.getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.triage-hold-text')?.textContent).toBe('Finish or clear the 1 unsent response first.')
  click(buttonLabelled('Show it'))
  await settle()
  expect(document.activeElement).toBe(answerInput(r.id))
  expect(answerInput(r.id)?.value).toBe('Approve as written.')
})
