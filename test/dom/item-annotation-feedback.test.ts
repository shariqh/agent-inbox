// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  annotateItem, dismissItem, getItem, insertItem, markItemAnnotationDelivered,
  markReplySeen, replyItem, resolveItem,
} from '../../src/store.js'
import {
  advanceClock, badgeCount, bootApp, buttonLabelled, click, expectConsoleError,
  freshDb, noteEditor, openOnFind, pollTick, settle, type, useDomTest, writeItemNote,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  vi.unstubAllGlobals()
})

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const HUMAN_TEXT = '  Keep the rollback.\nDo not publish <img src=x onerror=alert(1)> yet. 😀  '

function scope(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`.panel:not([hidden]) [data-card-id="${id}"]`)!
}

// UX pass, slice 4: notes and finished things are rows on Find that open in place
async function showItem(id: string, tab: 'find' | 'dashboard') {
  if (tab === 'find') {
    await openOnFind(id)
    return
  }
  click(document.querySelector(`.tab[data-tab="${tab}"]`))
  await settle()
  const host = scope(id)
  if (host instanceof HTMLDetailsElement) {
    if (!host.open) click(host.querySelector(':scope > summary'))
  } else click(host)
  await settle()
}

function receipt(id: string): HTMLElement | null {
  return scope(id)?.querySelector('.item-annotation') ?? null
}

describe('informational item feedback', () => {
  it.each(['note', 'done'] as const)('shows real save, pickup, edit and clear receipts for an open %s without attention', async (kind) => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind, title: 'Agent update' })
    const bridge = await bootApp(db)
    await showItem(id, 'find')
    await writeItemNote(() => scope(id), HUMAN_TEXT)

    let saved = getItem(db, id)!
    expect(saved.annotation).toBe(HUMAN_TEXT)
    expect(JSON.parse(String(bridge.posts[0]!.init?.body))).toEqual({ text: HUMAN_TEXT })
    expect(receipt(id)?.dataset.noteState).toBe('waiting')
    expect(receipt(id)?.querySelector('.annotation')?.textContent).toContain(HUMAN_TEXT)
    expect(receipt(id)?.querySelector('img')).toBeNull()
    expect(receipt(id)?.querySelector('.pickup.awaiting')?.textContent).toBe('Saved · waiting for delivery')
    expect(badgeCount()).toBe(0)

    advanceClock()
    expect(markItemAnnotationDelivered(db, id, saved.response_revision, 'copilot-cli <reader>')).toBe(true)
    await pollTick()
    expect(receipt(id)?.dataset.noteState).toBe('picked')
    expect(receipt(id)?.querySelector('.pickup.picked')?.textContent).toContain('copilot-cli <reader> client')
    expect(receipt(id)?.querySelector('.pickup.picked')?.getAttribute('title')).toContain('not a unique session')
    expect(receipt(id)?.querySelector('reader')).toBeNull()
    expect(getItem(db, id)?.updated_at).toBe(saved.updated_at)
    expect(getItem(db, id)?.status).toBe('open')
    expect(badgeCount()).toBe(0)

    await writeItemNote(() => scope(id), 'Corrected rollout conditions.')
    saved = getItem(db, id)!
    expect(saved.annotation_seen_at).toBeNull()
    expect(receipt(id)?.dataset.noteState).toBe('waiting')
    expect(receipt(id)?.textContent).toContain('Corrected rollout conditions.')
    expect(receipt(id)?.textContent).not.toContain('Delivered')

    await writeItemNote(() => scope(id), '')
    const cleared = getItem(db, id)!
    expect(cleared.annotation).toBe('')
    expect(cleared.annotated_at).not.toBeNull()
    expect(cleared.response_revision).toBeGreaterThan(saved.response_revision)
    expect(receipt(id)?.textContent).toContain('Note cleared')
    expect(receipt(id)?.dataset.noteState).toBe('waiting')
    expect(receipt(id)?.textContent).not.toContain('Corrected rollout conditions.')
    expect(markItemAnnotationDelivered(db, id, cleared.response_revision, 'copilot-cli')).toBe(true)
    await pollTick()
    expect(receipt(id)?.dataset.noteState).toBe('picked')
    expect(receipt(id)?.textContent).toContain('Note cleared')
    expect(getItem(db, id)?.status).toBe('open')
    expect(badgeCount()).toBe(0)
  })

  it('does not inherit an old question reply pickup for a new or cleared note', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Publish?' })
    replyItem(db, id, 'Approved')
    const repliedAt = getItem(db, id)!.replied_at
    expect(markReplySeen(db, id, repliedAt)).toBe(true)
    advanceClock(60_000)
    await bootApp(db)
    await showItem(id, 'dashboard')
    await writeItemNote(() => scope(id), 'Keep the rollback.')
    expect(scope(id).querySelector('.reply-block .pickup.picked')).not.toBeNull()
    expect(receipt(id)?.querySelector('.pickup.awaiting')).not.toBeNull()
    expect(receipt(id)?.querySelector('.pickup.picked')).toBeNull()
    expect(getItem(db, id)?.reply_seen_at).toBe(repliedAt)

    const saved = getItem(db, id)!
    markItemAnnotationDelivered(db, id, saved.response_revision, 'note-reader')
    await pollTick()
    expect(receipt(id)?.querySelector('.pickup.picked')).not.toBeNull()
    await writeItemNote(() => scope(id), '')
    expect(scope(id).querySelector('.reply-block .pickup.picked')).not.toBeNull()
    expect(receipt(id)?.dataset.noteState).toBe('waiting')
    expect(receipt(id)?.textContent).toContain('Note cleared')
    expect(badgeCount()).toBe(0)
  })

  it('keeps a question unanswered when only its independent note was picked up', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Still needs an answer' })
    annotateItem(db, id, 'Additional context, not my decision.')
    const saved = getItem(db, id)!
    markItemAnnotationDelivered(db, id, saved.response_revision, 'reader')
    await bootApp(db)
    await showItem(id, 'dashboard')
    expect(receipt(id)?.dataset.noteState).toBe('picked')
    expect(scope(id).querySelector('.reply-block')).toBeNull()
    expect(scope(id).querySelector('.lifecycle-receipt')?.textContent ?? '').not.toContain('You answered')
    expect(scope(id).querySelector('.lifecycle-receipt')?.textContent ?? '').not.toContain('Delivered')
    expect(badgeCount()).toBe(1)
  })

  it('resets a same-millisecond edited note to waiting instead of retaining its previous pickup', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'note', title: 'Same-time edit' })
    annotateItem(db, id, 'First version.')
    const first = getItem(db, id)!
    markItemAnnotationDelivered(db, id, first.response_revision, 'reader')
    await bootApp(db)
    await showItem(id, 'find')
    expect(receipt(id)?.dataset.noteState).toBe('picked')
    vi.setSystemTime(Date.parse(first.annotated_at!))
    annotateItem(db, id, 'Second version.')
    expect(getItem(db, id)?.annotated_at).toBe(first.annotated_at)
    expect(getItem(db, id)!.response_revision).toBeGreaterThan(first.response_revision)
    await pollTick()
    expect(receipt(id)?.dataset.noteState).toBe('waiting')
    expect(receipt(id)?.textContent).toContain('Second version.')
    expect(badgeCount()).toBe(0)
  })

  it.each(['resolved', 'dismissed'] as const)('preserves a stale Note attempt refused on a %s item', async (closed) => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'note', title: 'Historical update' })
    annotateItem(db, id, 'Historical feedback.')
    const saved = getItem(db, id)!
    markItemAnnotationDelivered(db, id, saved.response_revision, 'reader')
    const bridge = await bootApp(db)
    await showItem(id, 'find')
    // the page still shows the item open: no poll has run since another actor closed it
    if (closed === 'resolved') resolveItem(db, id, 'Closed by another actor.')
    else dismissItem(db, id)
    const historical = getItem(db, id)!
    await writeItemNote(() => scope(id), HUMAN_TEXT)

    expect(bridge.posts).toHaveLength(1)
    expect(getItem(db, id)).toEqual(historical)
    const recovery = document.querySelector('.stale-drafts-fold')!
    expect(recovery?.textContent).toContain('Note was not saved')
    expect(recovery?.textContent).toContain(HUMAN_TEXT)
    expect(recovery?.querySelector('.pickup')).toBeNull()
    expect(buttonLabelled('Retry', recovery)).toBeNull()
    expect(badgeCount()).toBe(0)
    await showItem(id, 'find')
    expect(buttonLabelled('Note', scope(id))).toBeNull()
    expect(receipt(id)?.textContent).toContain('Historical feedback.')
  })

  it('keeps an unconfirmed clear through viewer restart, without automatic resend or a false delivery claim', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'note', title: 'Ambiguous clear' })
    annotateItem(db, id, 'Previous note.')
    const reload = vi.fn()
    vi.stubGlobal('location', { hash: '', reload })
    let boot = 'initial'
    let loseReply = true
    const bridge = await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        const response = await next()
        response.headers.set('x-inbox-boot', boot)
        if (loseReply && init?.method === 'POST' && String(input).endsWith('/annotate')) {
          loseReply = false
          throw new Error('lost annotation response')
        }
        return response
      },
    })
    await showItem(id, 'find')
    expectConsoleError(/lost annotation response/)
    await writeItemNote(() => scope(id), '')
    expect(getItem(db, id)?.annotation).toBe('')
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Note save was not confirmed')
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Clear note')

    boot = 'restarted'
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    expect(bridge.posts).toHaveLength(1)
    // Retry opens the Note editor on the item, holding the recovered text for review
    click(buttonLabelled('Retry', document.querySelector('.stale-drafts-fold')!))
    await settle()
    expect(noteEditor(scope(id))?.value).toBe('')
    expect(document.activeElement).toBe(noteEditor(scope(id)))
    click(buttonLabelled('Cancel', scope(id).querySelector('.note-editor')!))
    await settle()
    expect(bridge.posts).toHaveLength(1)
    expect(document.querySelector('.stale-drafts-fold')).not.toBeNull()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    click(buttonLabelled('Discard', document.querySelector('.stale-drafts-fold')!))
    await settle()
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reviews recovered text in the same Note editor before an explicit retry', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'done', title: 'Retry milestone correction' })
    let loseReply = true
    const bridge = await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        const response = await next()
        if (loseReply && init?.method === 'POST' && String(input).endsWith('/annotate')) {
          loseReply = false
          throw new Error('lost annotation response')
        }
        return response
      },
    })
    await showItem(id, 'find')
    expectConsoleError(/lost annotation response/)
    await writeItemNote(() => scope(id), 'Unconfirmed correction.')
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Unconfirmed correction.')
    click(buttonLabelled('Retry', document.querySelector('.stale-drafts-fold')!))
    await settle()
    expect(noteEditor(scope(id))?.value).toBe('Unconfirmed correction.')
    expect(bridge.posts, 'Retry sends nothing until the reviewed text is saved').toHaveLength(1)
    type(noteEditor(scope(id)), 'Reviewed correction.')
    click(buttonLabelled('Save', scope(id).querySelector('.note-editor')!))
    await settle()
    expect(bridge.posts).toHaveLength(2)
    expect(getItem(db, id)?.annotation).toBe('Reviewed correction.')
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
    await showItem(id, 'find')
    expect(receipt(id)?.dataset.noteState).toBe('waiting')
  })

  it('keeps a retry visible and non-discardable while its real save is pending', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'note', title: 'Pending correction retry' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let posts = 0
    const bridge = await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (init?.method === 'POST' && String(input).endsWith('/annotate')) {
          posts += 1
          if (posts === 1) {
            await next()
            throw new Error('lost annotation response')
          }
          if (posts === 2) await gate
        }
        return next()
      },
    })
    await showItem(id, 'find')
    expectConsoleError(/lost annotation response/)
    await writeItemNote(() => scope(id), 'First attempted correction.')
    click(buttonLabelled('Retry', document.querySelector('.stale-drafts-fold')!))
    await settle()
    expect(noteEditor(scope(id))?.value).toBe('First attempted correction.')
    type(noteEditor(scope(id)), 'Reviewed correction while retrying.')
    click(buttonLabelled('Save', scope(id).querySelector('.note-editor')!))
    try {
      await pollTick()
      const pending = document.querySelector('.stale-drafts-fold')!
      expect(pending?.textContent).toContain('Saving note')
      expect(pending?.textContent).toContain('Reviewed correction while retrying.')
      expect(buttonLabelled('Retry', pending)?.disabled).toBe(true)
      expect(buttonLabelled('Discard', pending)?.disabled).toBe(true)
      click(buttonLabelled('Retry', pending))
      expect(bridge.posts).toHaveLength(2)
    } finally {
      release()
      await settle()
    }
    expect(getItem(db, id)?.annotation).toBe('Reviewed correction while retrying.')
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
  })
})
