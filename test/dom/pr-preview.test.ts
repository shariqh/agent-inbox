// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { closeProject, getBoard, insertItem, listSourceLinks, upsertBoard, upsertSourceLink } from '../../src/store.js'
import { PREVIEW_TTL_MS } from '../../public/source.js'
import {
  answerInput, bootApp, click, freshDb, pollTick, row, settle, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })
const HEAD = 'a'.repeat(40)
const PREVIEW = 'https://preview.example/pr-41'

function seedLink(database: Database.Database, over = {}) {
  upsertSourceLink(database, {
    repo: 'o/n', branch: 'feature', pr_number: 41, pr_state: 'OPEN', pr_head_sha: HEAD,
    pr_url: 'https://github.com/o/n/pull/41',
    preview_url: PREVIEW, preview_environment: 'Preview', preview_deployment_id: 1,
    preview_updated_at: new Date().toISOString(), ...over,
  })
}

describe('preview links in actual approval cards', () => {
  it('shows a safe tabbable preview on approvals, not unrelated question cards', async () => {
    db = freshDb()
    const scope = { project: 'p', agent: 'copilot', stream: 'feature', repo: 'o/n', kind: 'question' as const }
    const id = insertItem(db, { ...scope, title: 'Approve PR', action_owner: 'approval' })
    const ordinary = insertItem(db, { ...scope, title: 'Choose a name', action_owner: 'decision' })
    seedLink(db)
    await bootApp(db)
    await showInbox()
    expect(row(id)?.querySelector(`a[href="${PREVIEW}"]`)).not.toBeNull()
    expect(row(ordinary)?.querySelector(`a[href="${PREVIEW}"]`)).toBeNull()
    click(row(id))
    await settle()
    const link = row(id)?.querySelector<HTMLAnchorElement>(`.card-origin a[href="${PREVIEW}"]`)
    expect(link?.textContent).toContain('Preview')
    expect(link?.tabIndex).toBe(0)
    expect(link?.target).toBe('_blank')
    expect(link?.rel).toBe('noopener noreferrer')
    link?.focus()
    expect(document.activeElement).toBe(link)
  })

  it('carries board identity to an approval row and keeps attention unchanged', async () => {
    db = freshDb()
    upsertBoard(db, {
      project: 'p', agent: 'copilot', stream: 'feature', repo: 'o/n', title: 'Release plan',
      rows: [{ label: 'Approve PR', status: 'blocked', action_owner: 'approval', next_step: 'Review this change' }],
    })
    const board = getBoard(db, 'p', 'Release plan')!
    const id = board.rows[0]!.id
    await bootApp(db)
    await showInbox()
    const title = document.title
    seedLink(db)
    await pollTick()
    const approval = document.querySelector<HTMLElement>(`[data-key-hint-owner="row:${id}"]`)
    expect(approval?.querySelector(`a[href="${PREVIEW}"]`)).not.toBeNull()
    click(approval)
    await settle()
    expect(approval?.querySelector(`.card-origin a[href="${PREVIEW}"]`) ?? document.querySelector(`[data-key-hint-owner="row:${id}"] .card-origin a[href="${PREVIEW}"]`)).not.toBeNull()
    expect(document.title).toBe(title)
  })

  it('invalidates a stale preview during a draft without losing the draft or silently retargeting the link', async () => {
    db = freshDb()
    const id = insertItem(db, {
      project: 'p', agent: 'copilot', stream: 'feature', repo: 'o/n',
      kind: 'question', title: 'Approve PR', action_owner: 'approval',
    })
    seedLink(db)
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    const input = answerInput(id)!
    type(input, 'Preserve my review notes')
    const original = row(id)!.querySelector<HTMLAnchorElement>(`.card-origin a[href="${PREVIEW}"]`)!
    expect(original).not.toBeNull()
    seedLink(db, { pr_head_sha: 'b'.repeat(40), preview_url: 'https://preview.example/new-head' })
    await pollTick()
    expect(answerInput(id)).toBe(input)
    expect(input.value).toBe('Preserve my review notes')
    expect(original.isConnected).toBe(true)
    expect(original.hasAttribute('href')).toBe(false)
    expect(original.getAttribute('aria-disabled')).toBe('true')
    expect(original.textContent).toContain('Preview')
  })

  it('withholds old, failed, unsafe, and closed-project previews without hiding approval controls', async () => {
    db = freshDb()
    const id = insertItem(db, {
      project: 'p', agent: 'copilot', stream: 'feature', repo: 'o/n',
      kind: 'question', title: 'Approve PR', action_owner: 'approval',
    })
    seedLink(db, { preview_url: 'javascript:alert(1)', preview_environment: '"><img src=x>' })
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    expect(row(id)?.querySelector('a[data-preview-key]')).toBeNull()
    expect(row(id)?.querySelector('img')).toBeNull()
    expect(answerInput(id)).not.toBeNull()
    seedLink(db, { preview_error: 'offline' })
    await pollTick()
    expect(row(id)?.querySelector('a[data-preview-key]')).toBeNull()
    seedLink(db)
    closeProject(db, 'p')
    await pollTick()
    expect(document.querySelector(`a[href="${PREVIEW}"]`)).toBeNull()
  })

  it.each(['item', 'row'])('withholds a retired %s project preview even when another project shares its branch', async (kind) => {
    db = freshDb()
    const scope = { agent: 'copilot', stream: 'feature', repo: 'o/n' }
    const kept = insertItem(db, { ...scope, project: 'kept', kind: 'question', title: 'Keep this approval', action_owner: 'approval' })
    let owner: string
    if (kind === 'item') {
      const retired = insertItem(db, { ...scope, project: 'retired', kind: 'question', title: 'Retired approval', action_owner: 'approval' })
      owner = `item:${retired}`
    } else {
      upsertBoard(db, {
        ...scope, project: 'retired', title: 'Retired plan',
        rows: [{ label: 'Retired approval', status: 'blocked', action_owner: 'approval' }],
      })
      owner = `row:${getBoard(db, 'retired', 'Retired plan')!.rows[0]!.id}`
    }
    seedLink(db)
    closeProject(db, 'retired')
    await bootApp(db)
    await showInbox()
    expect(listSourceLinks(db)[0]?.preview_url).toBe(PREVIEW)
    expect(row(kept)?.querySelector(`a[href="${PREVIEW}"]`)).not.toBeNull()
    click(document.querySelector('.closed-fold .rail-tab[data-project="retired"]'))
    await settle()
    const retired = document.querySelector<HTMLElement>(`.nrow[data-key-hint-owner="${owner}"]`)!
    expect(retired).not.toBeNull()
    expect(retired.querySelector(`a[href="${PREVIEW}"]`)).toBeNull()
    click(retired)
    await settle()
    expect(document.querySelector(`.nrow[data-key-hint-owner="${owner}"] .card-origin a[href="${PREVIEW}"]`)).toBeNull()
  })

  it('invalidates a retired-project preview inside a draft even when its branch stays active elsewhere', async () => {
    db = freshDb()
    const scope = { agent: 'copilot', stream: 'feature', repo: 'o/n', kind: 'question' as const, action_owner: 'approval' as const }
    const id = insertItem(db, { ...scope, project: 'retired', title: 'Retire me' })
    insertItem(db, { ...scope, project: 'kept', title: 'Keep me' })
    seedLink(db)
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    const input = answerInput(id)!
    type(input, 'Keep these notes')
    const link = row(id)!.querySelector<HTMLAnchorElement>('.card-origin a[data-preview-key]')!
    closeProject(db, 'retired')
    await pollTick()
    expect(listSourceLinks(db)[0]?.preview_url).toBe(PREVIEW)
    expect(input.isConnected).toBe(true)
    expect(input.value).toBe('Keep these notes')
    expect(link.hasAttribute('href')).toBe(false)
  })

  it('expires existing preview anchors even when subsequent polls never complete', async () => {
    db = freshDb()
    const id = insertItem(db, {
      project: 'p', agent: 'copilot', stream: 'feature', repo: 'o/n',
      kind: 'question', title: 'Approve PR', action_owner: 'approval',
    })
    seedLink(db)
    let stalled = false
    await bootApp(db, { interceptFetch: async (_input, _init, next) => stalled ? new Promise<Response>(() => {}) : next() })
    await showInbox()
    click(row(id))
    await settle()
    const input = answerInput(id)!
    type(input, 'Keep my draft while offline')
    const link = row(id)!.querySelector<HTMLAnchorElement>('.card-origin a[data-preview-key]')!
    expect(link.hasAttribute('href')).toBe(true)
    stalled = true
    await vi.advanceTimersByTimeAsync(PREVIEW_TTL_MS + 1)
    expect(input.isConnected).toBe(true)
    expect(input.value).toBe('Keep my draft while offline')
    expect(link.hasAttribute('href')).toBe(false)
    expect(link.getAttribute('aria-disabled')).toBe('true')
  })

  it('guards native context-menu link actions even before a throttled expiry timer runs', async () => {
    db = freshDb()
    const id = insertItem(db, {
      project: 'p', agent: 'copilot', stream: 'feature', repo: 'o/n',
      kind: 'question', title: 'Approve PR', action_owner: 'approval',
    })
    seedLink(db)
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    const link = row(id)!.querySelector<HTMLAnchorElement>('.card-origin a[data-preview-key]')!
    vi.setSystemTime(Date.now() + PREVIEW_TTL_MS)
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    link.dispatchEvent(menu)
    expect(menu.defaultPrevented).toBe(true)
    expect(link.hasAttribute('href')).toBe(false)
  })
})
