// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { advanceBoardRow, getBoard, getItem, insertItem, resolveItem, upsertBoard } from '../../src/store.js'
import {
  answerInput, badgeCount, bootApp, buttonLabelled, click, expectConsoleError, freshDb,
  pollTick, repaint, row, sendButton, settle, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
let reload: ReturnType<typeof vi.fn>
beforeEach(() => {
  reload = vi.fn()
  vi.stubGlobal('location', { hash: '', reload })
})
afterEach(() => {
  db?.close()
  db = null
  vi.unstubAllGlobals()
})

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

async function bootWithRestart(d: Database.Database) {
  let boot = 'original-viewer'
  const bridge = await bootApp(d, {
    // A restarted viewer marks every response, and one tick reads them all (#161).
    interceptFetch: async (_input, _init, next) => {
      const response = await next()
      response.headers.set('x-inbox-boot', boot)
      return response
    },
  })
  return { bridge, restart: () => { boot = 'restarted-viewer' } }
}

function contextInput(id: string): HTMLTextAreaElement {
  return row(id)!.querySelector<HTMLTextAreaElement>('.reply-context-input')!
}

function holdPost(match: string, response?: Response) {
  const fetchNow = globalThis.fetch
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST' && String(input).includes(match)) {
      await gate
      if (response) return response
    }
    return fetchNow(input, init)
  }
  return release
}

describe('viewer restart with human-owned work', () => {
  it('preserves an unsent answer and context while refreshing ambient data, then reloads after Send', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Release approval' })
    const { bridge, restart } = await bootWithRestart(db)
    await showInbox()
    click(row(id))
    await settle()
    type(answerInput(id), 'Approve only after the backup.')
    type(contextInput(id), 'Do not deploy before 09:00.')
    const editor = answerInput(id)!
    editor.focus()

    restart()
    insertItem(db, { ...AGENT, kind: 'question', title: 'New decision after restart' })
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    expect(answerInput(id)?.value).toBe('Approve only after the backup.')
    expect(contextInput(id).value).toBe('Do not deploy before 09:00.')
    expect(document.activeElement).toBe(editor)
    expect(badgeCount()).toBe(2)
    expect(bridge.posts).toHaveLength(0)
    expect(document.getElementById('pauseHint')?.textContent).toContain('Viewer updated')

    click(document.querySelector('.tab[data-tab="notes"]'))
    await settle()
    await showInbox()
    expect(answerInput(id)?.value).toBe('Approve only after the backup.')
    expect(contextInput(id).value).toBe('Do not deploy before 09:00.')
    click(sendButton(id))
    await settle()
    expect(getItem(db, id)?.reply).toBe('Approve only after the backup.')
    expect(getItem(db, id)?.reply_context).toBe('Do not deploy before 09:00.')
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads a changed boot normally when there is no protected work', async () => {
    db = freshDb()
    const { restart } = await bootWithRestart(db)
    restart()
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('protects a context-only draft and reloads after the human clears it', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Context only' })
    const { bridge, restart } = await bootWithRestart(db)
    await showInbox()
    click(row(id))
    await settle()
    type(contextInput(id), 'Keep this condition even without an answer.')
    restart()
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    expect(contextInput(id).value).toBe('Keep this condition even without an answer.')
    type(contextInput(id), '')
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(bridge.posts).toHaveLength(0)
  })

  it('keeps failed-send recovery until its exact intent is retried or discarded', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT, kind: 'question', title: 'Failed option',
      options: [{ label: 'Ship now', recommended: true }, { label: 'Hold' }],
    })
    const { bridge, restart } = await bootWithRestart(db)
    await showInbox()
    click(row(id))
    await settle()
    bridge.failPostsWith(503)
    expectConsoleError(/reply failed: HTTP 503/)
    click(row(id)!.querySelector('.opt-pill'))
    await settle()
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Ship now')
    const first = JSON.parse(String(bridge.posts[0]!.init?.body)) as Record<string, unknown>

    restart()
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Ship now')
    expect(document.getElementById('pauseHint')?.textContent).toContain('Viewer updated')
    bridge.failPostsWith(null)
    click(buttonLabelled('Retry', document.querySelector('.stale-drafts-fold')!))
    await settle()
    const retry = JSON.parse(String(bridge.posts[1]!.init?.body)) as Record<string, unknown>
    expect(retry.intent_action_id).toBe(first.intent_action_id)
    expect(retry.intent_sequence).toBe(first.intent_sequence)
    expect(getItem(db, id)?.reply).toBe('Ship now')
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('retains a removed question draft in established recovery until Clear', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Removed question' })
    const { bridge, restart } = await bootWithRestart(db)
    await showInbox()
    click(row(id))
    await settle()
    type(answerInput(id), 'Keep the removed question answer.')
    type(contextInput(id), 'The original condition.')
    restart()
    resolveItem(db, id)
    await pollTick()
    await repaint()
    expect(reload).not.toHaveBeenCalled()
    const recovery = document.querySelector('.stale-drafts-fold')!
    expect(recovery.textContent).toContain('Keep the removed question answer.')
    expect(recovery.textContent).toContain('The original condition.')
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    click(buttonLabelled('Clear', document.querySelector('.stale-drafts-fold')!))
    await settle()
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(bridge.posts).toHaveLength(0)
  })

  it('keeps a prior row revision in recovery instead of applying its draft to the replacement action', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT, title: 'Versioned plan',
      rows: [{ label: 'Approval', status: 'blocked', context: 'Original action context' }],
    })
    const original = getBoard(db, AGENT.project, 'Versioned plan')!
    const rowId = original.rows[0]!.id
    const { bridge, restart } = await bootWithRestart(db)
    await showInbox()
    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'Only approve the original action.')
    expect(advanceBoardRow(db, {
      project: AGENT.project,
      title: 'Versioned plan',
      label: 'Approval',
      expectedBoardVersion: original.revision,
      expectedRevision: original.rows[0]!.revision,
      note: 'Replacement action',
      next_step: 'Choose for the replacement.',
      action_owner: 'approval',
      impact: 'Continues the replacement action.',
      context: 'New context',
    }).ok).toBe(true)

    restart()
    await pollTick()
    await repaint()
    expect(reload).not.toHaveBeenCalled()
    expect(answerInput(rowId)?.value).toBe('')
    const recovery = document.querySelector('.stale-drafts-fold')!
    expect(recovery.textContent).toContain('Only approve the original action.')
    expect(recovery.textContent).toContain('Original action context')
    expect(recovery.textContent).toContain(`action ${original.rows[0]!.action_version}`)
    expect(bridge.posts).toHaveLength(0)
    click(buttonLabelled('Clear', recovery))
    await settle()
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload during an undrafted option POST and preserves its failure before resuming refresh', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT, kind: 'question', title: 'In-flight option',
      options: [{ label: 'Ship now', recommended: true }, { label: 'Hold' }],
    })
    const { restart } = await bootWithRestart(db)
    await showInbox()
    click(row(id))
    await settle()
    const release = holdPost(`/items/${id}/reply`, new Response('offline', { status: 503 }))
    expectConsoleError(/reply failed: HTTP 503/)
    click(row(id)!.querySelector('.opt-pill'))
    restart()
    try {
      await pollTick()
      expect(reload).not.toHaveBeenCalled()
      expect(document.getElementById('pauseHint')?.textContent).toBe('')
    } finally {
      release()
      await settle()
    }
    await settle()
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    const recovery = document.querySelector('.stale-drafts-fold')!
    expect(recovery.textContent).toContain('Ship now')
    click(buttonLabelled('Clear', recovery))
    await settle()
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it.each(['star', 'dismiss'] as const)('does not flush a staged %s when the viewer restarts', async (action) => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT, kind: 'question', title: 'Staged work', detail: 'Choose the release timing.',
      options: [{ label: 'Ship now', recommended: true }, { label: 'Hold' }],
    })
    const { bridge, restart } = await bootWithRestart(db)
    await showInbox()
    click(row(id)!.querySelector(action === 'star' ? '.star-btn' : '.nrow-dismiss'))
    restart()
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    expect(bridge.posts).toHaveLength(0)
    click(buttonLabelled(action === 'star' ? 'Undo' : 'Undo dismiss', row(id)!))
    await settle()
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it.each(['star', 'dismiss'] as const)('waits for a staged %s to settle before the coherent reload', async (action) => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT, kind: 'question', title: 'Staged completion', detail: 'Choose the release timing.',
      options: [{ label: 'Ship now', recommended: true }, { label: 'Hold' }],
    })
    const { bridge, restart } = await bootWithRestart(db)
    await showInbox()
    const release = holdPost(`/items/${id}/${action === 'star' ? 'reply' : 'dismiss'}`)
    click(row(id)!.querySelector(action === 'star' ? '.star-btn' : '.nrow-dismiss'))
    restart()
    try {
      await vi.advanceTimersByTimeAsync(6200)
      expect(reload).not.toHaveBeenCalled()
      expect(bridge.posts).toHaveLength(0)
    } finally {
      release()
      await settle()
    }
    expect(bridge.posts).toHaveLength(1)
    expect(action === 'star' ? getItem(db, id)?.reply : getItem(db, id)?.status)
      .toBe(action === 'star' ? 'Ship now' : 'dismissed')
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('preserves a failed staged answer in recovery instead of reloading away the selected response', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT, kind: 'question', title: 'Failed staged answer', detail: 'Choose the release timing.',
      options: [{ label: 'Ship now', recommended: true }, { label: 'Hold' }],
    })
    const { bridge, restart } = await bootWithRestart(db)
    await showInbox()
    bridge.failPostsWith(503)
    expectConsoleError(/reply failed: HTTP 503/)
    click(row(id)!.querySelector('.star-btn'))
    restart()
    await vi.advanceTimersByTimeAsync(6200)
    expect(reload).not.toHaveBeenCalled()
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Ship now')
    expect(bridge.posts).toHaveLength(1)
    click(buttonLabelled('Clear', document.querySelector('.stale-drafts-fold')!))
    await settle()
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('protects an in-flight row option through failure recovery without a typed editor draft', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT, title: 'Pending row option',
      rows: [{
        label: 'Approval', status: 'blocked', context: 'Original row identity',
        options: [{ label: 'Ship now' }, { label: 'Hold' }],
      }],
    })
    const original = getBoard(db, AGENT.project, 'Pending row option')!
    const rowId = original.rows[0]!.id
    const { restart } = await bootWithRestart(db)
    await showInbox()
    click(row(rowId))
    await settle()
    const release = holdPost(`/rows/${rowId}/annotate`, new Response('offline', { status: 503 }))
    expectConsoleError(/annotate failed: HTTP 503/)
    click(buttonLabelled('Ship now', row(rowId)!))
    restart()
    try {
      await pollTick()
      expect(reload).not.toHaveBeenCalled()
    } finally {
      release()
      await settle()
    }
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    expect(answerInput(rowId)?.value).toBe('Ship now')
    expect(getBoard(db, AGENT.project, 'Pending row option')!.rows[0]!.revision)
      .toBe(original.rows[0]!.revision)
    type(answerInput(rowId), '')
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('defers a work-free restart through a held press without asking the human to finish a response', async () => {
    db = freshDb()
    const { restart } = await bootWithRestart(db)
    await vi.advanceTimersByTimeAsync(2800)
    window.dispatchEvent(new Event('pointerdown'))
    restart()
    await vi.advanceTimersByTimeAsync(200)
    expect(reload).not.toHaveBeenCalled()
    expect(document.getElementById('pauseHint')?.textContent).toBe('')
    window.dispatchEvent(new Event('pointerup'))
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
