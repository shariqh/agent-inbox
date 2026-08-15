// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  getBoard, getItem, insertItem, markReplySeen, replyItem, resolveItem, upsertBoard,
} from '../../src/store.js'
import {
  answerInput, bootApp, buttonLabelled, click, collapseRow, expectConsoleError, freshDb, pollTick, row,
  settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

function deferPost(match: string, response?: Response): () => void {
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

function holdFirstPost(match: string): {
  release: () => void
  started: () => number
} {
  const fetchNow = globalThis.fetch
  let count = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST' && String(input).includes(match) && ++count === 1) {
      await gate
    }

    return fetchNow(input, init)
  }
  return { release, started: () => count }
}

function stubNavigationType(type: 'navigate' | 'reload'): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window.performance, 'getEntriesByType')
  Object.defineProperty(window.performance, 'getEntriesByType', {
    configurable: true,
    value: () => [{ type }],
  })
  return () => {
    if (descriptor) Object.defineProperty(window.performance, 'getEntriesByType', descriptor)
    else Reflect.deleteProperty(window.performance, 'getEntriesByType')
  }
}

function failSecondPost(match: string, status: number): void {
  const fetchNow = globalThis.fetch
  let count = 0
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST' && String(input).includes(match) && ++count === 2) {
      return new Response('failed', { status })
    }
    return fetchNow(input, init)
  }
}

function boardPanelInput(rowId: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(
    `#boards [data-row-id="${rowId}"] + .row-panel-row .reply-input`,
  )!
}

describe('async draft ownership', () => {
  it('does not let a late row save erase newer text typed in a duplicate editor', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Duplicate editors',
      rows: [{ label: 'Approve launch', status: 'blocked', note: 'Choose now.' }],
    })
    const board = getBoard(db, 'alpha', 'Duplicate editors')!
    const rowId = board.rows[0]!.id
    await bootApp(db)

    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(buttonLabelled('Answer', document.querySelector(`[data-row-id="${rowId}"]`)!))
    await settle()
    click(buttonLabelled('Review queue'))
    await settle()

    const lightbox = document.getElementById('lightbox')!
    const triageInput = lightbox.querySelector<HTMLInputElement>('.reply-input')!
    type(triageInput, 'submission A')
    const release = deferPost(`/rows/${rowId}/annotate`)
    click(buttonLabelled('Send', lightbox))
    type(boardPanelInput(rowId), 'newer draft B')
    release()
    await settle()

    expect(getBoard(db, 'alpha', 'Duplicate editors')!.rows[0]!.annotation).toBe('submission A')
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('newer draft B')
  })

  it('does not restore a failed row submission over a newer draft', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Failed save',
      rows: [{ label: 'Approve launch', status: 'blocked', note: 'Choose now.' }],
    })
    const rowId = getBoard(db, 'alpha', 'Failed save')!.rows[0]!.id
    await bootApp(db)

    click(row(rowId))
    await settle()
    const input = answerInput(rowId)!
    type(input, 'submission A')
    expectConsoleError(/annotate failed: HTTP 503/)
    const release = deferPost(`/rows/${rowId}/annotate`, new Response('offline', { status: 503 }))
    click(buttonLabelled('Send', row(rowId)!))
    type(input, 'newer draft B')
    release()
    await settle()

    expect(answerInput(rowId)?.value).toBe('newer draft B')
    expect(document.querySelector('.stale-drafts-fold')?.textContent ?? '').not.toContain('submission A')
  })

  it('does not let a late row CAS refusal displace a newer draft', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Refused save',
      rows: [{ label: 'Approve launch', status: 'blocked', note: 'Choose now.' }],
    })
    const rowId = getBoard(db, 'alpha', 'Refused save')!.rows[0]!.id
    await bootApp(db)

    click(row(rowId))
    await settle()
    const input = answerInput(rowId)!
    type(input, 'submission A')
    const release = deferPost(`/rows/${rowId}/annotate`, new Response(
      JSON.stringify({ ok: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    click(buttonLabelled('Send', row(rowId)!))
    type(input, 'newer draft B')
    release()
    await settle()

    expect(answerInput(rowId)?.value).toBe('newer draft B')
    expect(document.querySelector('.stale-drafts-fold')?.textContent ?? '').not.toContain('submission A')
  })

  it('recovers the later of two option submissions when the earlier one wins the CAS race', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Option race',
      rows: [{
        label: 'Choose rollout',
        status: 'blocked',
        note: 'Pick one.',
        options: [{ label: 'Ship now' }, { label: 'Hold' }],
      }],
    })
    const rowId = getBoard(db, 'alpha', 'Option race')!.rows[0]!.id
    await bootApp(db)
    click(row(rowId))
    await settle()

    const release = deferPost(`/rows/${rowId}/annotate`)
    click(buttonLabelled('Ship now', row(rowId)!))
    click(buttonLabelled('Hold', row(rowId)!))
    release()
    await settle()

    expect(getBoard(db, 'alpha', 'Option race')!.rows[0]!.annotation).toBe('Ship now')
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Hold')
  })

  it('preserves a newer item answer when an earlier successful reply completes', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Ship it?' })
    await bootApp(db)

    click(row(id))
    await settle()
    const input = answerInput(id)!
    type(input, 'submission A')
    const release = deferPost(`/items/${id}/reply`)
    click(buttonLabelled('Send', row(id)!))
    type(input, 'newer draft B')
    release()
    await settle()

    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('newer draft B')
    expect(row(id)?.textContent).toContain('submission A')
  })

  it('does not let a delayed staged-star reply retire a draft typed after staging', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Pick rollout',
      detail: 'Choose the rollout timing.',
      options: [{ label: 'Ship now', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(db)

    click(row(id)?.querySelector('.star-btn'))
    click(row(id))
    await settle()
    type(answerInput(id), 'newer draft B')
    await vi.advanceTimersByTimeAsync(5000)
    await settle()

    expect(row(id)?.textContent).toContain('Ship now')
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('newer draft B')
  })

  it('starts same-item replies immediately and lets the store reject a late older intent', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Transport order',
      options: [{ label: 'Intent A' }, { label: 'Intent B' }],
    })
    await bootApp(db)
    click(row(id))
    await settle()

    const held = holdFirstPost(`/items/${id}/reply`)
    click(buttonLabelled('Intent A', row(id)!))
    click(buttonLabelled('Intent B', row(id)!))
    await vi.advanceTimersByTimeAsync(0)
    const startedBeforeRelease = held.started()
    const storedBeforeRelease = getItem(db, id)?.reply
    held.release()
    await settle()

    expect(startedBeforeRelease).toBe(2)
    expect(storedBeforeRelease).toBe('Intent B')
    expect(getItem(db, id)?.reply).toBe('Intent B')
    expect(row(id)?.textContent).toContain('Intent B')
  })

  it('regenerates corrupt window reply intent state before sending', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Corrupt intent state',
      options: [{ label: 'Safe reply' }],
    })
    sessionStorage.setItem('agent-inbox-reply-intent', JSON.stringify({
      clientId: '   ',
      sequence: Number.MAX_SAFE_INTEGER,
    }))
    const bridge = await bootApp(db)

    click(row(id))
    await settle()
    click(buttonLabelled('Safe reply', row(id)!))
    await settle()

    const request = bridge.posts.find((post) => post.url.includes(`/items/${id}/reply`))
    const body = JSON.parse(String(request?.init?.body))
    expect(body.intent_client_id.trim()).not.toBe('')
    expect(body.intent_client_id.length).toBeLessThanOrEqual(128)
    expect(body.intent_sequence).toBe(1)
    expect(body.intent_action_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(getItem(db, id)?.reply).toBe('Safe reply')
  })

  it('cancels an older staged-star intent when a newer direct answer is submitted', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Cancel staged intent',
      detail: 'Choose one.',
      options: [{ label: 'Staged A', recommended: true }, { label: 'Direct B' }],
    })
    const bridge = await bootApp(db)

    click(row(id)?.querySelector('.star-btn'))
    click(row(id))
    await settle()
    click(buttonLabelled('Direct B', row(id)!))
    await vi.advanceTimersByTimeAsync(5000)
    await settle()

    expect(getItem(db, id)?.reply).toBe('Direct B')
    expect(bridge.posts.filter((post) => post.url.includes(`/items/${id}/reply`))).toHaveLength(1)
  })

  it('surfaces the latest option intent when it fails after an older reply succeeds', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Latest failure',
      options: [{ label: 'Intent A' }, { label: 'Intent B' }],
    })
    await bootApp(db)
    click(row(id))
    await settle()

    expectConsoleError(new RegExp(`/items/${id}/reply failed: HTTP 503`))
    failSecondPost(`/items/${id}/reply`, 503)
    click(buttonLabelled('Intent A', row(id)!))
    click(buttonLabelled('Intent B', row(id)!))
    await settle()

    expect(getItem(db, id)?.reply).toBe('Intent A')
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Intent B')
    expect(document.getElementById('pauseHint')?.textContent).toBe('')
  })

  it('keeps a failed option intent separate from an existing text draft', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Draft plus option',
      options: [{ label: 'Option Y' }],
    })
    const bridge = await bootApp(db)
    click(row(id))
    await settle()
    const input = answerInput(id)
    type(input, 'Draft X')

    const release = deferPost(`/items/${id}/reply`)
    click(buttonLabelled('Option Y', row(id)!))
    type(input, 'Draft X, revised while Y sends')
    expectConsoleError(new RegExp(`/items/${id}/reply failed: HTTP 503`))
    bridge.failPostsWith(503)
    release()
    await settle()
    bridge.failPostsWith(null)

    expect(answerInput(id)?.value).toBe('Draft X, revised while Y sends')
    const recovery = document.querySelector<HTMLElement>('.stale-drafts-fold')!
    expect(recovery.textContent).toContain('Option Y')
    click(buttonLabelled('Retry', recovery))
    await settle()

    expect(getItem(db, id)?.reply).toBe('Option Y')
    const remaining = document.querySelector('.stale-drafts-fold')?.textContent ?? ''
    expect(remaining).toContain('Draft X, revised while Y sends')
    expect(remaining).not.toContain('Option Y')
  })

  it('lets a newer Undo reach transport immediately and defeat a delayed staged reply', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Undo transport',
      detail: 'Choose one.',
      options: [{ label: 'Staged A', recommended: true }],
    })
    await bootApp(db)
    const held = holdFirstPost(`/items/${id}/reply`)

    click(row(id)?.querySelector('.star-btn'))
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    click(buttonLabelled('Undo', row(id)!))
    await vi.advanceTimersByTimeAsync(0)
    const startedBeforeRelease = held.started()
    held.release()
    await settle()

    expect(startedBeforeRelease).toBe(2)
    expect(getItem(db, id)?.reply).toBeNull()
  })

  it('restores prior reply ownership when a staged star is cancelled before send', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Cancel staged ownership',
      detail: 'Choose one.',
      options: [{ label: 'Staged choice', recommended: true }],
    })
    await bootApp(db)
    click(row(id))
    await settle()
    type(answerInput(id), 'Earlier text reply')

    const held = holdFirstPost(`/items/${id}/reply`)
    click(buttonLabelled('Send', row(id)!))
    await vi.advanceTimersByTimeAsync(0)
    await collapseRow(id)
    click(row(id)?.querySelector('.star-btn'))
    held.release()
    await settle()
    click(buttonLabelled('Undo', row(id)!))
    await settle()
    await pollTick()

    expect(getItem(db, id)?.reply).toBe('Earlier text reply')
    expect(answerInput(id)).toBeNull()
    expect(document.querySelector('.stale-drafts-fold')?.textContent ?? '')
      .not.toContain('Earlier text reply')
    expect(document.getElementById('pauseHint')?.textContent).toBe('')
  })

  it('keeps an ambiguous draft retry exact when a staged star is undone before transport', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Undo preserves retry identity',
      detail: 'Choose one.',
      options: [{ label: 'Staged B', recommended: true }],
    })
    const bridge = await bootApp(db)
    const fetchNow = globalThis.fetch
    let loseFirstResponse = true
    globalThis.fetch = async (input, init) => {
      if (
        loseFirstResponse
        && init?.method === 'POST'
        && String(input).includes(`/items/${id}/reply`)
      ) {
        loseFirstResponse = false
        await fetchNow(input, init)
        throw new Error('lost original response')
      }
      return fetchNow(input, init)
    }
    expectConsoleError(/lost original response/)

    click(row(id))
    await settle()
    type(answerInput(id), 'Original A')
    click(buttonLabelled('Send', row(id)!))
    await settle()

    click(row(id)?.querySelector('.star-btn'))
    click(buttonLabelled('Undo', row(id)!))
    await settle()

    expect(replyItem(db, id, 'Later Y', undefined, 'answer', {
      clientId: 'other-window',
      sequence: 1,
      actionId: 'later-after-staged-undo',
    })).toBe(true)
    const later = getItem(db, id)!
    expect(markReplySeen(db, id, later.replied_at)).toBe(true)

    click(buttonLabelled('Send', row(id)!))
    await settle()

    const replyPosts = bridge.posts.filter((post) => post.url.includes(`/items/${id}/reply`))
    const first = JSON.parse(String(replyPosts[0]?.init?.body))
    const retry = JSON.parse(String(replyPosts[1]?.init?.body))
    expect(retry.intent_action_id).toBe(first.intent_action_id)
    expect(retry.intent_sequence).toBe(first.intent_sequence)
    expect(getItem(db, id)?.reply).toBe('Later Y')
    expect(getItem(db, id)?.reply_seen_at).not.toBeNull()
  })

  it('cancels a staged star when the preserved draft is retried before transport', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Retry cancels staged answer',
      detail: 'Choose one.',
      options: [{ label: 'Staged B', recommended: true }],
    })
    const bridge = await bootApp(db)
    const fetchNow = globalThis.fetch
    let loseFirstResponse = true
    globalThis.fetch = async (input, init) => {
      if (
        loseFirstResponse
        && init?.method === 'POST'
        && String(input).includes(`/items/${id}/reply`)
      ) {
        loseFirstResponse = false
        await fetchNow(input, init)
        throw new Error('lost original response')
      }
      return fetchNow(input, init)
    }
    expectConsoleError(/lost original response/)

    click(row(id))
    await settle()
    type(answerInput(id), 'Original A')
    click(buttonLabelled('Send', row(id)!))
    await settle()

    click(row(id)?.querySelector('.star-btn'))
    click(buttonLabelled('Send', row(id)!))
    await settle()
    await vi.advanceTimersByTimeAsync(5000)
    await settle()

    const replyPosts = bridge.posts.filter((post) => post.url.includes(`/items/${id}/reply`))
    expect(replyPosts).toHaveLength(2)
    const first = JSON.parse(String(replyPosts[0]?.init?.body))
    const retry = JSON.parse(String(replyPosts[1]?.init?.body))
    expect(retry.text).toBe('Original A')
    expect(retry.intent_action_id).toBe(first.intent_action_id)
    expect(retry.intent_sequence).toBe(first.intent_sequence)
  })

  it('invalidates an ambiguous draft retry only when a staged star enters transport', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Fire invalidates retry identity',
      detail: 'Choose one.',
      options: [{ label: 'Staged B', recommended: true }],
    })
    const bridge = await bootApp(db)
    const fetchNow = globalThis.fetch
    let loseFirstResponse = true
    globalThis.fetch = async (input, init) => {
      if (
        loseFirstResponse
        && init?.method === 'POST'
        && String(input).includes(`/items/${id}/reply`)
      ) {
        loseFirstResponse = false
        await fetchNow(input, init)
        throw new Error('lost pre-stage response')
      }
      return fetchNow(input, init)
    }
    expectConsoleError(/lost pre-stage response/)

    click(row(id))
    await settle()
    type(answerInput(id), 'Original A')
    click(buttonLabelled('Send', row(id)!))
    await settle()

    click(row(id)?.querySelector('.star-btn'))
    const held = holdFirstPost(`/items/${id}/reply`)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(0)
    click(buttonLabelled('Send', row(id)!))
    await vi.advanceTimersByTimeAsync(0)
    expect(held.started()).toBe(2)
    held.release()
    await settle()

    const originalPosts = bridge.posts
      .filter((post) => post.url.includes(`/items/${id}/reply`))
      .map((post) => JSON.parse(String(post.init?.body)))
      .filter((body) => body.text === 'Original A')
    expect(originalPosts).toHaveLength(2)
    expect(originalPosts[1].intent_action_id).not.toBe(originalPosts[0].intent_action_id)
    expect(originalPosts[1].intent_sequence).toBeGreaterThan(originalPosts[0].intent_sequence)
  })

  it('keeps failed option and orphaned text recoveries distinct and clears only the chosen entry', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Distinct item recoveries',
      options: [{ label: 'Option Y' }],
    })
    const bridge = await bootApp(db)
    click(row(id))
    await settle()
    type(answerInput(id), 'Text X')

    const release = deferPost(`/items/${id}/reply`)
    click(buttonLabelled('Option Y', row(id)!))
    resolveItem(db, id)
    expectConsoleError(new RegExp(`/items/${id}/reply failed: HTTP 503`))
    bridge.failPostsWith(503)
    release()
    await settle()
    bridge.failPostsWith(null)

    const lines = [...document.querySelectorAll<HTMLElement>('.stale-drafts-fold .stale-draft-line')]
    expect(lines).toHaveLength(2)
    expect(lines.some((line) => line.textContent?.includes('Option Y'))).toBe(true)
    expect(lines.some((line) => line.textContent?.includes('Text X'))).toBe(true)
    const optionLine = lines.find((line) => line.textContent?.includes('Option Y'))!
    expect(buttonLabelled('Retry', optionLine)).not.toBeNull()
    click(buttonLabelled('Clear', optionLine))

    const remaining = document.querySelector('.stale-drafts-fold')?.textContent ?? ''
    expect(remaining).toContain('Text X')
    expect(remaining).not.toContain('Option Y')
  })

  it('retries an uncertain option with the exact action identity without resetting pickup', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Exact recovery replay',
      options: [{ label: 'Option Y' }],
    })
    await bootApp(db)
    const fetchNow = globalThis.fetch
    let loseFirstResponse = true
    globalThis.fetch = async (input, init) => {
      if (
        loseFirstResponse
        && init?.method === 'POST'
        && String(input).includes(`/items/${id}/reply`)
      ) {
        loseFirstResponse = false
        await fetchNow(input, init)
        throw new Error('lost response')
      }
      return fetchNow(input, init)
    }
    expectConsoleError(/lost response/)

    click(row(id))
    await settle()
    click(buttonLabelled('Option Y', row(id)!))
    await settle()
    const applied = getItem(db, id)!
    expect(applied.reply).toBe('Option Y')
    expect(markReplySeen(db, id, applied.replied_at)).toBe(true)

    const recovery = document.querySelector<HTMLElement>('.stale-drafts-fold')!
    click(buttonLabelled('Retry', recovery))
    await settle()

    expect(getItem(db, id)?.reply_seen_at).not.toBeNull()
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
  })

  it('retires an exact recovery when its in-flight free-text reply succeeds after owner removal', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Removed while sending',
    })
    insertItem(db, { ...AGENT, kind: 'question', title: 'Review target' })
    await bootApp(db)

    click(row(id))
    await settle()
    type(answerInput(id), 'Submission A')
    const release = deferPost(`/items/${id}/reply`)
    click(buttonLabelled('Send', row(id)!))
    resolveItem(db, id)
    await pollTick()
    click(buttonLabelled('Review queue'))
    await settle()

    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Submission A')
    release()
    await settle()

    expect(getItem(db, id)?.reply).toBe('Submission A')
    expect(document.querySelector('.stale-drafts-fold')?.textContent ?? '').not.toContain('Submission A')
  })

  it('retries an owner-removed ambiguous free-text reply with its exact action identity', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Removed ambiguous reply',
    })
    insertItem(db, { ...AGENT, kind: 'question', title: 'Review target' })
    const bridge = await bootApp(db)
    const fetchNow = globalThis.fetch
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let loseFirstResponse = true
    globalThis.fetch = async (input, init) => {
      if (
        loseFirstResponse
        && init?.method === 'POST'
        && String(input).includes(`/items/${id}/reply`)
      ) {
        loseFirstResponse = false
        await gate
        await fetchNow(input, init)
        throw new Error('lost in-flight response')
      }
      return fetchNow(input, init)
    }
    expectConsoleError(/lost in-flight response/)

    click(row(id))
    await settle()
    type(answerInput(id), 'Original X')
    click(buttonLabelled('Send', row(id)!))
    resolveItem(db, id)
    await pollTick()
    click(buttonLabelled('Review queue'))
    await settle()
    release()
    await settle()

    expect(replyItem(db, id, 'Later Y', undefined, 'answer', {
      clientId: 'other-window',
      sequence: 1,
      actionId: 'later-owner-removal',
    })).toBe(true)
    const later = getItem(db, id)!
    expect(markReplySeen(db, id, later.replied_at)).toBe(true)

    click(buttonLabelled('Retry', document.querySelector('.stale-drafts-fold')!))
    await settle()

    const replyPosts = bridge.posts.filter((post) => post.url.includes(`/items/${id}/reply`))
    const first = JSON.parse(String(replyPosts[0]?.init?.body))
    const retry = JSON.parse(String(replyPosts[1]?.init?.body))
    expect(retry.intent_action_id).toBe(first.intent_action_id)
    expect(retry.intent_sequence).toBe(first.intent_sequence)
    expect(getItem(db, id)?.reply).toBe('Later Y')
    expect(getItem(db, id)?.reply_seen_at).not.toBeNull()
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
  })

  it('keeps a newer owner-removed draft recovery independent from an older in-flight success', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Independent removed draft',
    })
    insertItem(db, { ...AGENT, kind: 'question', title: 'Review target' })
    await bootApp(db)

    click(row(id))
    await settle()
    const input = answerInput(id)
    type(input, 'Submission A')
    const release = deferPost(`/items/${id}/reply`)
    click(buttonLabelled('Send', row(id)!))
    type(input, 'Newer draft B')
    resolveItem(db, id)
    await pollTick()
    click(buttonLabelled('Review queue'))
    await settle()
    release()
    await settle()

    const recovery = document.querySelector('.stale-drafts-fold')?.textContent ?? ''
    expect(recovery).toContain('Newer draft B')
    expect(recovery).not.toContain('Submission A')
    expect(getItem(db, id)?.reply).toBe('Submission A')
  })

  it('retires a staged-action-superseded recovery without restoring its invalidated retry identity', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Superseded in-flight draft',
      detail: 'Choose the response.',
      options: [{ label: 'Option Y', recommended: true }],
    })
    insertItem(db, { ...AGENT, kind: 'question', title: 'Review target' })
    await bootApp(db)

    click(row(id))
    await settle()
    type(answerInput(id), 'Submission A')
    const release = deferPost(`/items/${id}/reply`)
    click(buttonLabelled('Send', row(id)!))
    await vi.advanceTimersByTimeAsync(0)
    await collapseRow(id)
    click(row(id)?.querySelector('.star-btn'))
    resolveItem(db, id)
    await pollTick()
    click(buttonLabelled('Review queue'))
    await settle()
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Submission A')

    release()
    await settle()

    expect(getItem(db, id)?.reply).toBe('Submission A')
    expect(document.querySelector('.stale-drafts-fold')?.textContent ?? '').not.toContain('Submission A')
  })

  it('removes an exact recovery when a newer reply makes its held request definitively stale', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Definitively stale recovery',
      options: [{ label: 'Newer B' }],
    })
    insertItem(db, { ...AGENT, kind: 'question', title: 'Review target' })
    await bootApp(db)
    const fetchNow = globalThis.fetch
    let releaseA!: () => void
    let releaseB!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    const gateB = new Promise<void>((resolve) => { releaseB = resolve })
    let count = 0
    globalThis.fetch = async (input, init) => {
      if (init?.method === 'POST' && String(input).includes(`/items/${id}/reply`)) {
        count += 1
        if (count === 1) await gateA
        if (count === 2) await gateB
      }
      return fetchNow(input, init)
    }

    click(row(id))
    await settle()
    type(answerInput(id), 'Submission A')
    click(buttonLabelled('Send', row(id)!))
    await vi.advanceTimersByTimeAsync(0)
    click(buttonLabelled('Newer B', row(id)!))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)

    resolveItem(db, id)
    await pollTick()
    click(buttonLabelled('Review queue'))
    await settle()
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Submission A')

    releaseB()
    await settle()
    const newer = getItem(db, id)!
    expect(newer.reply).toBe('Newer B')
    expect(markReplySeen(db, id, newer.replied_at)).toBe(true)

    releaseA()
    await settle()

    expect(getItem(db, id)?.reply).toBe('Newer B')
    expect(getItem(db, id)?.reply_seen_at).not.toBeNull()
    expect(document.querySelector('.stale-drafts-fold')?.textContent ?? '').not.toContain('Submission A')
  })

  it('does not let rejected A delete an ambiguous exact recovery now owned by retry C', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Immutable recovery owner',
      options: [{ label: 'Newer B' }],
    })
    insertItem(db, { ...AGENT, kind: 'question', title: 'Review target' })
    await bootApp(db)
    const fetchNow = globalThis.fetch
    let releaseA!: () => void
    let releaseB!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    const gateB = new Promise<void>((resolve) => { releaseB = resolve })
    const bodies: Array<Record<string, unknown>> = []
    let count = 0
    globalThis.fetch = async (input, init) => {
      if (init?.method === 'POST' && String(input).includes(`/items/${id}/reply`)) {
        const requestNumber = ++count
        bodies.push(JSON.parse(String(init.body)))
        if (requestNumber === 1) await gateA
        if (requestNumber === 2) await gateB
        if (requestNumber >= 3) throw new Error(`ambiguous retry ${requestNumber}`)
      }
      return fetchNow(input, init)
    }

    click(row(id))
    await settle()
    type(answerInput(id), 'Submission A')
    click(buttonLabelled('Send', row(id)!))
    await vi.advanceTimersByTimeAsync(0)
    click(buttonLabelled('Newer B', row(id)!))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)

    resolveItem(db, id)
    await pollTick()
    click(buttonLabelled('Review queue'))
    await settle()
    const recovery = document.querySelector<HTMLElement>('.stale-drafts-fold')!
    expect(recovery.textContent).toContain('Submission A')

    expectConsoleError(/ambiguous retry 3/)
    click(buttonLabelled('Retry', recovery))
    await settle()
    const retryC = bodies[2]!

    releaseB()
    await settle()
    const newer = getItem(db, id)!
    expect(newer.reply).toBe('Newer B')
    expect(markReplySeen(db, id, newer.replied_at)).toBe(true)

    releaseA()
    await settle()
    expect(getItem(db, id)?.reply).toBe('Newer B')
    expect(getItem(db, id)?.reply_seen_at).not.toBeNull()
    const retained = document.querySelector<HTMLElement>('.stale-drafts-fold')!
    expect(retained.textContent).toContain('Submission A')

    expectConsoleError(/ambiguous retry 4/)
    click(buttonLabelled('Retry', retained))
    await settle()
    const exactRetry = bodies[3]!
    expect(exactRetry.intent_action_id).toBe(retryC.intent_action_id)
    expect(exactRetry.intent_sequence).toBe(retryC.intent_sequence)
    expect(getItem(db, id)?.reply).toBe('Newer B')
    expect(getItem(db, id)?.reply_seen_at).not.toBeNull()
  })

  it('allows only one in-flight exact retry from the same recovery control', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Single retry lease',
      options: [{ label: 'Option Y' }],
    })
    await bootApp(db)
    const fetchNow = globalThis.fetch
    let loseFirstResponse = true
    globalThis.fetch = async (input, init) => {
      if (
        loseFirstResponse
        && init?.method === 'POST'
        && String(input).includes(`/items/${id}/reply`)
      ) {
        loseFirstResponse = false
        await fetchNow(input, init)
        throw new Error('lost initial response')
      }
      return fetchNow(input, init)
    }
    expectConsoleError(/lost initial response/)

    click(row(id))
    await settle()
    click(buttonLabelled('Option Y', row(id)!))
    await settle()

    const held = holdFirstPost(`/items/${id}/reply`)
    const recovery = document.querySelector<HTMLElement>('.stale-drafts-fold')!
    const retry = buttonLabelled('Retry', recovery)
    click(retry)
    click(retry)
    await vi.advanceTimersByTimeAsync(0)
    expect(held.started()).toBe(1)

    held.release()
    await settle()
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
  })

  it('retires an older identical option recovery after a newer direct action succeeds', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Direct option retry',
      options: [{ label: 'Option Y' }],
    })
    const bridge = await bootApp(db)
    click(row(id))
    await settle()

    expectConsoleError(new RegExp(`/items/${id}/reply failed: HTTP 503`))
    bridge.failPostsWith(503)
    click(buttonLabelled('Option Y', row(id)!))
    await settle()
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Option Y')

    bridge.failPostsWith(null)
    click(buttonLabelled('Option Y', row(id)!))
    await settle()

    expect(getItem(db, id)?.reply).toBe('Option Y')
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
  })

  it('reuses an unchanged free-text action after an ambiguous failure without overwriting a later reply', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Ambiguous free text',
    })
    const bridge = await bootApp(db)
    const fetchNow = globalThis.fetch
    let loseFirstResponse = true
    globalThis.fetch = async (input, init) => {
      if (
        loseFirstResponse
        && init?.method === 'POST'
        && String(input).includes(`/items/${id}/reply`)
      ) {
        loseFirstResponse = false
        await fetchNow(input, init)
        throw new Error('lost text response')
      }
      return fetchNow(input, init)
    }
    expectConsoleError(/lost text response/)

    click(row(id))
    await settle()
    type(answerInput(id), 'Original X')
    click(buttonLabelled('Send', row(id)!))
    await settle()
    expect(getItem(db, id)?.reply).toBe('Original X')

    expect(replyItem(db, id, 'Later Y', undefined, 'answer', {
      clientId: 'other-window',
      sequence: 1,
      actionId: 'later-y',
    })).toBe(true)
    const later = getItem(db, id)!
    expect(markReplySeen(db, id, later.replied_at)).toBe(true)

    click(buttonLabelled('Send', row(id)!))
    await settle()

    const replyPosts = bridge.posts.filter((post) => post.url.includes(`/items/${id}/reply`))
    const first = JSON.parse(String(replyPosts[0]?.init?.body))
    const retry = JSON.parse(String(replyPosts[1]?.init?.body))
    expect(retry.intent_action_id).toBe(first.intent_action_id)
    expect(retry.intent_sequence).toBe(first.intent_sequence)
    expect(getItem(db, id)?.reply).toBe('Later Y')
    expect(getItem(db, id)?.reply_seen_at).not.toBeNull()
  })

  it('invalidates an ambiguous free-text action as soon as the draft is edited', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Edited ambiguous text',
    })
    const bridge = await bootApp(db)
    const fetchNow = globalThis.fetch
    let loseFirstResponse = true
    globalThis.fetch = async (input, init) => {
      if (
        loseFirstResponse
        && init?.method === 'POST'
        && String(input).includes(`/items/${id}/reply`)
      ) {
        loseFirstResponse = false
        await fetchNow(input, init)
        throw new Error('lost edited response')
      }
      return fetchNow(input, init)
    }
    expectConsoleError(/lost edited response/)

    click(row(id))
    await settle()
    const input = answerInput(id)
    type(input, 'Draft A')
    click(buttonLabelled('Send', row(id)!))
    await settle()
    type(input, 'Draft B')
    click(buttonLabelled('Send', row(id)!))
    await settle()

    const replyPosts = bridge.posts.filter((post) => post.url.includes(`/items/${id}/reply`))
    const first = JSON.parse(String(replyPosts[0]?.init?.body))
    const edited = JSON.parse(String(replyPosts[1]?.init?.body))
    expect(edited.intent_action_id).not.toBe(first.intent_action_id)
    expect(edited.intent_sequence).toBeGreaterThan(first.intent_sequence)
    expect(getItem(db, id)?.reply).toBe('Draft B')
  })

  it('rekeys an inherited client on ordinary navigation so a dormant cloned tab can submit', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Cloned navigation',
      options: [{ label: 'Clone answer' }],
    })
    expect(replyItem(db, id, 'Other clone sequence 2', undefined, 'answer', {
      clientId: 'inherited-client',
      sequence: 2,
      actionId: 'other-clone-action',
    })).toBe(true)
    expect(replyItem(db, id, '')).toBe(true)
    sessionStorage.setItem('agent-inbox-reply-intent', JSON.stringify({
      clientId: 'inherited-client',
      sequence: 0,
    }))
    const restoreNavigation = stubNavigationType('navigate')
    const bridge = await bootApp(db)
    restoreNavigation()

    click(row(id))
    await settle()
    click(buttonLabelled('Clone answer', row(id)!))
    await settle()

    const request = bridge.posts.find((post) => post.url.includes(`/items/${id}/reply`))
    const body = JSON.parse(String(request?.init?.body))
    expect(body.intent_client_id).not.toBe('inherited-client')
    expect(body.intent_sequence).toBe(1)
    expect(getItem(db, id)?.reply).toBe('Clone answer')
  })

  it('reuses the persisted client and counter only for a verified same-tab reload', async () => {
    db = freshDb()
    const id = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Reload navigation',
      options: [{ label: 'Reload answer' }],
    })
    sessionStorage.setItem('agent-inbox-reply-intent', JSON.stringify({
      clientId: 'same-tab-client',
      sequence: 4,
    }))
    const restoreNavigation = stubNavigationType('reload')
    const bridge = await bootApp(db)
    restoreNavigation()

    click(row(id))
    await settle()
    click(buttonLabelled('Reload answer', row(id)!))
    await settle()

    const request = bridge.posts.find((post) => post.url.includes(`/items/${id}/reply`))
    const body = JSON.parse(String(request?.init?.body))
    expect(body.intent_client_id).toBe('same-tab-client')
    expect(body.intent_sequence).toBe(5)
  })
})

describe('direct overlay draft reconciliation', () => {
  it('recovers a removed row before Review queue navigation can retire its editor', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Removed owner',
      rows: [{ label: 'Draft owner A', status: 'blocked', note: 'Choose.' }],
    })
    const original = getBoard(db, 'alpha', 'Removed owner')!
    const rowId = original.rows[0]!.id
    insertItem(db, { ...AGENT, kind: 'question', title: 'Review target B' })
    await bootApp(db)

    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'draft owned by removed A')
    upsertBoard(db, {
      ...AGENT,
      title: 'Removed owner',
      expectedVersion: original.revision,
      rows: [],
    })
    await pollTick()

    click(buttonLabelled('Review queue'))
    await settle()

    expect(document.getElementById('lightbox')?.hidden).toBe(true)
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('draft owned by removed A')
    expect(document.getElementById('pauseHint')?.textContent).toBe('')
  })

  it('recovers a removed mission editor before navigating to another Plan row', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Mission owners',
      rows: [
        { label: 'Draft owner A', status: 'blocked', note: 'Choose A.' },
        { label: 'Mission target B', status: 'blocked', note: 'Choose B.' },
      ],
    })
    const original = getBoard(db, 'alpha', 'Mission owners')!
    const owner = original.rows[0]!
    await bootApp(db)

    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(buttonLabelled('Plan flow'))
    const missionBox = document.getElementById('missionbox')!
    const missionButton = (label: string): HTMLButtonElement =>
      [...missionBox.querySelectorAll<HTMLButtonElement>('.mission-node')]
        .find((button) => button.textContent?.includes(label))!
    click(missionButton('Draft owner A'))
    await settle()
    type(document.querySelector<HTMLInputElement>('#missionbox .mission-detail .reply-input'), 'mission draft A')
    upsertBoard(db, {
      ...AGENT,
      title: 'Mission owners',
      expectedVersion: original.revision,
      rows: [{
        label: 'Mission target B',
        revision: original.rows[1]!.revision,
        status: 'blocked',
        note: 'Choose B.',
      }],
    })
    await pollTick()

    click(missionButton('Mission target B'))
    await settle()

    expect(document.getElementById('missionbox')?.hidden).toBe(true)
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('mission draft A')
  })

  it('preserves the focused Review queue control across poll rerenders', async () => {
    db = freshDb()
    insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Review focus',
      options: [{ label: 'Approve' }, { label: 'Hold' }],
    })
    await bootApp(db)
    click(buttonLabelled('Review queue'))
    await settle()

    const lightbox = document.getElementById('lightbox')!
    const before = buttonLabelled('Hold', lightbox)!
    before.focus()
    await pollTick()

    const after = buttonLabelled('Hold', lightbox)!
    expect(before.isConnected).toBe(false)
    expect(document.activeElement).toBe(after)
  })

  it('removes only the submitted Review queue row when its delayed save completes', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Delayed triage',
      rows: [
        { label: 'Submitted row A', status: 'blocked', note: 'Choose A.' },
        { label: 'Current row B', status: 'blocked', note: 'Choose B.' },
      ],
    })
    const board = getBoard(db, 'alpha', 'Delayed triage')!
    const first = board.rows[0]!
    await bootApp(db)
    click(buttonLabelled('Review queue'))
    await settle()

    const lightbox = document.getElementById('lightbox')!
    type(lightbox.querySelector<HTMLInputElement>('.reply-input'), 'Answer A')
    const release = deferPost(`/rows/${first.id}/annotate`)
    click(buttonLabelled('Send', lightbox))
    click(lightbox.querySelector('.lb-next'))
    expect(lightbox.querySelector('.title')?.textContent).toContain('Current row B')
    release()
    await settle()

    expect(lightbox.hidden).toBe(false)
    expect(lightbox.querySelector('.title')?.textContent).toContain('Current row B')
    expect(lightbox.querySelector('.lb-count')?.textContent).toBe('1 of 1')
  })

  it('falls back to the Review queue dialog when a focused control changes identity', async () => {
    db = freshDb()
    insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Compare focus',
      options: [
        { label: 'Ship', detail: 'Ship today.' },
        { label: 'Hold', detail: 'Wait a day.' },
      ],
    })
    await bootApp(db)
    click(buttonLabelled('Review queue'))
    await settle()

    const lightbox = document.getElementById('lightbox')!
    const compare = buttonLabelled('Compare', lightbox)!
    compare.focus()
    click(compare)
    await settle()

    expect(document.activeElement).toBe(lightbox.querySelector('.lb-panel'))
    expect(buttonLabelled('Hide compare', lightbox)).not.toBeNull()
  })

  it('does not transfer focus from a removed Review queue entry to the next row', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Focus completion',
      rows: [
        { label: 'Focused row A', status: 'blocked', note: 'Choose A.' },
        { label: 'Next row B', status: 'blocked', note: 'Choose B.' },
      ],
    })
    const first = getBoard(db, 'alpha', 'Focus completion')!.rows[0]!
    await bootApp(db)
    click(buttonLabelled('Review queue'))
    await settle()

    const lightbox = document.getElementById('lightbox')!
    type(lightbox.querySelector<HTMLInputElement>('.reply-input'), 'Answer A')
    const send = buttonLabelled('Send', lightbox)!
    send.focus()
    const release = deferPost(`/rows/${first.id}/annotate`)
    click(send)
    release()
    await settle()

    expect(lightbox.querySelector('.title')?.textContent).toContain('Next row B')
    expect(document.activeElement).toBe(lightbox.querySelector('.lb-panel'))
  })
})
