// @vitest-environment jsdom
// test/dom/card-links.test.ts — issue #300: links detected in agent text, made
// clickable inline, hoisted into a Links strip at the top of every open card,
// and opened through the one preload method (or copied, in a browser).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, resolveItem, upsertBoard, upsertSourceLink } from '../../src/store.js'
import {
  advanceClock, badgeCount, bootApp, click, freshDb, pollTick, row, settle, showInbox, tabCount, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'agentInboxLinks')
  Reflect.deleteProperty(navigator, 'clipboard')
})

const REPO = 'shariqh/agent-inbox'
const SCOPE = { project: 'alpha', agent: 'claude', stream: '300-links', repo: REPO } as const
const DETAIL = 'Spec at /Users/s/docs/spec.md:12 and https://example.com/guide; see #301. Not the #1 cause, not /api/items, not v1.6.'
const CONTEXT = 'Background in ~/notes/plan.md'

function seed(d: Database.Database, over: Record<string, unknown> = {}): string {
  return insertItem(d, {
    ...SCOPE, kind: 'question', title: 'Review the links in PR #284', issue_ref: 300, detail: DETAIL, context: CONTEXT, ...over,
  })
}

function seedPr(d: Database.Database): void {
  upsertSourceLink(d, {
    repo: REPO, branch: '300-links', pr_number: 284, pr_state: 'OPEN', pr_title: 'Links in the Inbox',
    pr_url: 'https://github.com/shariqh/agent-inbox/pull/284',
  })
}

const stripOf = (root: ParentNode | null | undefined) => root?.querySelector<HTMLElement>('.card-links') ?? null
const chips = (root: ParentNode | null | undefined) =>
  [...(stripOf(root)?.querySelectorAll('.src-chip') ?? [])].map((chip) => chip.textContent?.replace(/\s+/g, ' ').trim())
const cardOf = (id: string) => row(id)?.querySelector<HTMLElement>('.nrow-card') ?? null

async function openInspector(d: Database.Database, id: string): Promise<HTMLElement> {
  await bootApp(d)
  await showInbox()
  click(row(id))
  await settle()
  return cardOf(id)!
}

// Click as a person would and report whether the app took over the default;
// then stop jsdom's own navigation, which it does not implement.
function clickPrevented(el: Element, init: MouseEventInit = {}): boolean {
  let prevented = false
  el.addEventListener('click', (event) => { prevented = event.defaultPrevented; event.preventDefault() }, { once: true })
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }))
  return prevented
}

type LinkAnswer = (request: { kind: string }) => Promise<Record<string, unknown>>

function bridge(answer: LinkAnswer = async (request) => (request.kind === 'file'
  ? { ok: true, action: 'revealed', reason: 'blocked' }
  : { ok: true, action: 'opened' })) {
  const open = vi.fn(answer)
  Object.defineProperty(window, 'agentInboxLinks', { configurable: true, value: { open } })
  return open
}

const status = () => document.getElementById('linkOpenStatus')?.textContent ?? ''

describe('the Links strip (issue #300)', () => {
  it('lists the card’s links under its origin: own PR and issue first, then first appearance, once each', async () => {
    db = freshDb()
    const id = seed(db)
    seedPr(db)
    const card = await openInspector(db, id)

    expect(chips(card)).toEqual(['PR #284', 'Issue #300', 'File spec.md:12', 'Web example.com/guide', 'Issue #301', 'File plan.md'])
    const strip = stripOf(card)!
    expect(strip.getAttribute('role')).toBe('group')
    expect(strip.getAttribute('aria-label')).toBe('Links')
    expect(strip.previousElementSibling?.classList.contains('card-origin')).toBe(true)
    expect(strip.compareDocumentPosition(card.querySelector('.card-tldr')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const pr = strip.querySelector<HTMLAnchorElement>('a[data-link-kind="pr"]')!
    expect(pr.href).toBe('https://github.com/shariqh/agent-inbox/pull/284')
    expect(pr.target).toBe('_blank')
    expect(pr.rel).toBe('noopener noreferrer')
    const file = strip.querySelector<HTMLButtonElement>('button[data-link-kind="file"]')!
    expect(file.dataset.linkPath).toBe('/Users/s/docs/spec.md')
    expect(file.hasAttribute('href')).toBe(false)
    expect(file.title).toBe('/Users/s/docs/spec.md:12')
  })

  it('makes references and paths clickable inline, read against the item’s repository, and leaves prose alone', async () => {
    db = freshDb()
    const id = seed(db)
    const card = await openInspector(db, id)

    const tldr = card.querySelector('.card-tldr-body')!
    expect(tldr.querySelector<HTMLAnchorElement>('a[data-link-kind="issue"]')?.href).toBe('https://github.com/shariqh/agent-inbox/issues/301')
    const path = tldr.querySelector<HTMLElement>('.file-link')!
    expect(path.textContent).toBe('/Users/s/docs/spec.md:12')
    expect(path.getAttribute('role')).toBe('button')
    expect(path.tabIndex).toBe(0)
    expect(path.hasAttribute('href')).toBe(false)
    expect(tldr.querySelectorAll('[data-link-kind]')).toHaveLength(3)
    expect(card.querySelector('.nrow-card-head .card-title a[data-link-kind="pr"]')?.getAttribute('href'))
      .toBe('https://github.com/shariqh/agent-inbox/pull/284')
  })

  it('draws no strip when the text names nothing beyond the card’s own PR and issue', async () => {
    db = freshDb()
    const id = seed(db, { detail: 'PR #284 closes #300.', context: undefined })
    seedPr(db)
    const card = await openInspector(db, id)
    expect(stripOf(card)).toBeNull()
    expect(card.querySelector('.card-origin a[href="https://github.com/shariqh/agent-inbox/pull/284"]')).not.toBeNull()
  })

  it('appears on every card surface: Review queue, Notes, History and the Plans row panel', async () => {
    db = freshDb()
    seed(db)
    advanceClock()
    const note = insertItem(db, { ...SCOPE, kind: 'note', title: 'Wrote the notes', detail: 'Read ~/notes/today.md' })
    advanceClock()
    const done = insertItem(db, { ...SCOPE, kind: 'question', title: 'Ship?', detail: 'Ready' })
    resolveItem(db, done, 'Shipped; changelog at https://example.com/changelog')
    upsertBoard(db, {
      ...SCOPE, title: 'Links plan',
      rows: [{ label: 'Draft the spec', status: 'tracked', note: 'Draft in /Users/s/docs/draft.md' }],
    })
    await bootApp(db)

    click(document.querySelector('.triage-btn'))
    await settle()
    expect(chips(document.querySelector('#lightbox .lb-card'))).toContain('File spec.md:12')
    click(document.querySelector('#lightbox .lb-close'))
    await settle()

    click(document.querySelector('.tab[data-tab="notes"]'))
    await settle()
    expect(chips(document.querySelector(`#notes [data-card-id="${note}"]`))).toEqual(['File today.md'])

    click(document.querySelector('.tab[data-tab="done"]'))
    await settle()
    expect(chips(document.querySelector(`#done [data-card-id="${done}"]`))).toEqual(['Web example.com/changelog'])

    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector('#boards .board-row'))
    await settle()
    expect(chips(document.querySelector('#boards .row-panel'))).toEqual(['File draft.md'])
  })

  it('folds links past six into “+N more”, and a poll keeps it open and focus on its chip', async () => {
    db = freshDb()
    const many = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}`).join(' ')
    const id = insertItem(db, { ...SCOPE, kind: 'question', title: 'Many links', detail: many })
    const card = await openInspector(db, id)

    expect(stripOf(card)!.querySelectorAll(':scope > .src-chip')).toHaveLength(6)
    const more = card.querySelector<HTMLDetailsElement>('details.card-links-more')!
    expect(more.querySelector('summary')?.textContent).toBe('+3 more')
    more.open = true
    more.dispatchEvent(new Event('toggle'))
    card.querySelector<HTMLAnchorElement>('details.card-links-more a[href="https://example.com/7"]')!.focus()
    advanceClock()
    const arrival = insertItem(db, { ...SCOPE, kind: 'question', title: 'Unrelated arrival' })

    await pollTick()

    expect(row(arrival)).not.toBeNull()
    expect(cardOf(id)?.querySelector<HTMLDetailsElement>('details.card-links-more')?.open).toBe(true)
    expect(document.activeElement?.getAttribute('href')).toBe('https://example.com/7')
    expect(cardOf(id)?.contains(document.activeElement)).toBe(true)
  })

  it('never takes focus: a poll that brings new links leaves the search box focused', async () => {
    db = freshDb()
    const id = seed(db)
    await openInspector(db, id)
    const search = document.getElementById('search') as HTMLInputElement
    search.focus()
    advanceClock()
    insertItem(db, { ...SCOPE, kind: 'question', title: 'Arrival with ~/x.md and #302' })

    await pollTick()

    expect(document.activeElement).toBe(search)
  })

  it('keeps a selection across a poll that rebuilds linked text', async () => {
    db = freshDb()
    const id = seed(db)
    const card = await openInspector(db, id)
    const tldr = card.querySelector('.card-tldr-body')!
    const start = [...tldr.childNodes].flatMap((node) => [...node.childNodes]).find((node) => node.textContent?.startsWith('Spec at'))!
    const end = tldr.querySelector('a[data-link-kind="issue"]')!.firstChild!
    document.getSelection()!.setBaseAndExtent(start, 0, end, 4)
    const selected = document.getSelection()!.toString()
    expect(selected).toBe('Spec at /Users/s/docs/spec.md:12 and https://example.com/guide; see #301')
    advanceClock()
    insertItem(db, { ...SCOPE, kind: 'question', title: 'Unrelated arrival' })

    await pollTick()

    expect(start.isConnected).toBe(false)
    expect(document.getSelection()?.toString()).toBe(selected)
  })
})

describe('opening a link (issue #300)', () => {
  it('in the desktop app, asks main through the one preload method and says what it did', async () => {
    const open = bridge()
    db = freshDb()
    const id = seed(db)
    const card = await openInspector(db, id)
    const strip = stripOf(card)!

    click(strip.querySelector('button[data-link-kind="file"]'))
    await settle()
    expect(open).toHaveBeenLastCalledWith({ kind: 'file', path: '/Users/s/docs/spec.md' })
    expect(status()).toContain('Agent Inbox never opens apps, scripts, installers or aliases.')

    expect(clickPrevented(strip.querySelector('a[data-link-kind="web"]')!)).toBe(true)
    expect(open).toHaveBeenLastCalledWith({ kind: 'web', url: 'https://example.com/guide' })
    expect(clickPrevented(card.querySelector('.card-tldr-body a[data-link-kind="issue"]')!)).toBe(true)
    expect(open).toHaveBeenLastCalledWith({ kind: 'web', url: 'https://github.com/shariqh/agent-inbox/issues/301' })

    open.mockClear()
    expect(clickPrevented(strip.querySelector('a[data-link-kind="web"]')!, { metaKey: true })).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('opens an inline path from the keyboard, and reports a missing file', async () => {
    const open = bridge(async () => ({ ok: false, reason: 'missing' }))
    db = freshDb()
    const id = seed(db)
    const card = await openInspector(db, id)
    const path = card.querySelector<HTMLElement>('.card-tldr-body .file-link')!
    path.focus()
    path.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(open).toHaveBeenCalledWith({ kind: 'file', path: '/Users/s/docs/spec.md' })
    expect(status()).toBe('Not found: /Users/s/docs/spec.md')
    expect(row(id)?.getAttribute('aria-expanded')).toBe('true')
  })

  it('says when a file was only shown because Agent Inbox does not open its type', async () => {
    bridge(async () => ({ ok: true, action: 'revealed', reason: 'type' }))
    db = freshDb()
    const id = seed(db)
    const card = await openInspector(db, id)
    click(stripOf(card)!.querySelector('button[data-link-kind="file"]'))
    await settle()
    expect(status()).toMatch(/^Shown in .+: this type isn’t opened automatically\.$/)
  })

  it('in a browser, a file link copies its path and says why; web links keep their own behaviour', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    db = freshDb()
    const id = seed(db)
    const card = await openInspector(db, id)
    const strip = stripOf(card)!

    click(strip.querySelector('button[data-link-kind="file"]'))
    await settle()
    expect(writeText).toHaveBeenCalledWith('/Users/s/docs/spec.md')
    expect(status()).toBe('Copied the path. A browser can’t open local files.')
    expect(clickPrevented(strip.querySelector('a[data-link-kind="web"]')!)).toBe(false)
  })
})

describe('links are never attention (issue #300)', () => {
  it.each([
    ['without links', 'nothing to open here'],
    ['with links', 'see #301, PR #284, https://example.com/x and /Users/s/a.md'],
  ])('the badge, tabs and queue read the same %s', async (_name, text) => {
    db = freshDb()
    seed(db, { title: `Decide: ${text}`, detail: text, context: text })
    advanceClock()
    insertItem(db, { ...SCOPE, kind: 'note', title: text, detail: text })
    upsertBoard(db, {
      ...SCOPE, title: 'Plan',
      rows: [{ label: 'Row', status: 'blocked', note: text, next_step: 'Do it', action_owner: 'task', impact: text }],
    })
    await bootApp(db)
    await showInbox()
    expect([badgeCount(), tabCount('needsYou'), tabCount('notes'), document.querySelectorAll('#needsYouList .nrow[data-card-id]').length])
      .toEqual([2, '2', '1', 2])
  })

  it('no attention module reads links', () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    for (const file of ['public/attention.js', 'public/badge.js', 'public/card.js', 'public/relay.js', 'electron/reply-watch.cjs']) {
      const code = readFileSync(join(repo, file), 'utf8')
      expect(code, file).not.toMatch(/link-strip|links\.js|link-open|data-link/)
    }
  })
})
