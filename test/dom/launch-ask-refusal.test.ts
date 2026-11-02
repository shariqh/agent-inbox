// @vitest-environment jsdom
// Issue #412 step 3: an app launch's approval ask is answered only by Electron
// main's signed answer, so the viewer's reply and note routes refuse it. The
// page says where to answer instead, records no answer, and keeps any text the
// human typed.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { createLaunch, fileLaunchAsk, getItem, insertItem } from '../../src/store.js'
import { answerInput, bootApp, buttonLabelled, click, freshDb, row, sendButton, settle, type, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const LAUNCH = '11111111-2222-4333-8444-555555555555'

function launchAsk(d: Database.Database): string {
  createLaunch(d, {
    id: LAUNCH, host: 'copilot', project: 'alpha', stream: 'main', cwd: '/work/alpha', mode: 'ask', budgetActiveMs: 60_000,
    budgetToolCalls: 5, prompt: 'Fix it.', specVersion: 1, driverPid: 1,
  })
  return fileLaunchAsk(d, LAUNCH, {
    project: '@sessions', stream: 'alpha · main', agent: 'copilot', kind: 'question', title: 'Allow copilot to run `npm test`?',
    detail: 'A session Agent Inbox drives is waiting for your approval.', next_step: 'Approve or decline in the Agent Inbox app.',
    action_owner: 'approval', impact: 'The agent waits until you answer.',
    options: [{ label: 'Allow once', detail: 'Lets this one tool call run.' }, { label: 'Deny', detail: 'Declining stops the agent’s current turn.' }],
  }, [{ optionId: 'allow_once', label: 'Allow once' }, { optionId: 'reject_once', label: 'Deny' }]).itemId
}

const errorText = (id: string) => row(id)?.querySelector<HTMLElement>(`.write-error[data-error-for="${id}"]`)?.textContent ?? ''

describe('an app launch’s ask in the ordinary viewer (#412 step 3)', () => {
  it('refuses an option chosen on the page with a plain message, and records no answer', async () => {
    db = freshDb()
    const id = launchAsk(db)
    await bootApp(db)
    click(row(id))
    await settle()
    click(buttonLabelled('Allow once', row(id)!))
    await settle()
    expect(errorText(id)).toBe('Not sent — approve this from Agent Inbox’s own window.')
    expect(getItem(db, id)).toMatchObject({ status: 'open', reply: null, reply_context: null, response_revision: 0 })
  })

  it('draws no Resolve, Dismiss or ✕ for it, and the keyboard closes nothing', async () => {
    db = freshDb()
    const id = launchAsk(db)
    const other = insertItem(db, { project: 'alpha', stream: '', agent: 'claude', kind: 'question', title: 'Plain?' })
    await bootApp(db)
    expect(row(id)!.querySelector('.nrow-dismiss')).toBeNull()
    expect(row(other)!.querySelector('.nrow-dismiss')).not.toBeNull()
    click(row(id))
    await settle()
    expect(buttonLabelled('Resolve', row(id)!)).toBeNull()
    expect(buttonLabelled('Dismiss', row(id)!)).toBeNull()
    for (const key of ['x', 'e']) document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await settle()
    expect(getItem(db, id)!.status).toBe('open')
  })

  it('says where to answer if a Resolve or Dismiss reaches the viewer anyway', async () => {
    db = freshDb()
    const id = launchAsk(db)
    await bootApp(db)
    click(row(id))
    await settle()
    const response = await fetch(`/api/items/${id}/dismiss`, { method: 'POST' })
    expect(await response.json()).toEqual({ ok: false, reason: 'launch_ask' })
    expect(getItem(db, id)!.status).toBe('open')
  })

  it('refuses a typed answer the same way and keeps the text in its editor', async () => {
    db = freshDb()
    const id = launchAsk(db)
    await bootApp(db)
    click(row(id))
    await settle()
    type(answerInput(id), 'Yes, go ahead.')
    click(sendButton(id))
    await settle()
    expect(errorText(id)).toBe('Not sent — approve this from Agent Inbox’s own window.')
    expect(answerInput(id)!.value).toBe('Yes, go ahead.')
    expect(getItem(db, id)!.reply).toBeNull()
  })
})
