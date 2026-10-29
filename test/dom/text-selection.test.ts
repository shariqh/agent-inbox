// @vitest-environment jsdom
// test/dom/text-selection.test.ts
//
// Issue #223: the 3-second poll rebuilds the list and inspector DOM, and a
// rebuild detaches the text nodes a selection lives in. A live range follows
// its removed nodes up to their parent and collapses there, so the highlight
// the human just made vanished on the next tick.
//
// The fix records a non-collapsed selection as stable anchors before each
// editable rebuild and restores it afterwards when the same text is still
// there. It adds no render gate: a selection never defers a frame, so it can
// never freeze the viewer the way an unbounded gate would (the C1 lesson).
//
// jsdom implements Selection and live ranges per the DOM spec, which is exactly
// the mechanism the bug depends on. The CONTROL test proves each tick really
// replaces the selected node, so the restore tests cannot pass by never
// rebuilding.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listBoards, replyItem, resolveItem, upsertActivity, upsertBoard } from '../../src/store.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, buttonLabelled, click, freshDb, pollTick, repaint, row,
  settle, showInbox, tabCount, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null; vi.restoreAllMocks() })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const
const DETAIL = 'Run the migration command before the canary deploy.'

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

function locate(root: Element | null | undefined, needle: string): { node: Text, offset: number } {
  if (!root) throw new Error(`locate(): nothing to search for "${needle}"`)
  for (const node of textNodes(root)) {
    const offset = node.data.indexOf(needle)
    if (offset >= 0) return { node, offset }
  }
  throw new Error(`locate(): "${needle}" is not inside one text node`)
}

/** Leave the selection a pointer drag over `needle` would leave. */
function selectText(root: Element | null | undefined, needle: string, { backward = false } = {}): Text {
  const { node, offset } = locate(root, needle)
  const end = offset + needle.length
  const selection = document.getSelection()!
  if (backward) selection.setBaseAndExtent(node, end, node, offset)
  else selection.setBaseAndExtent(node, offset, node, end)
  return node
}

function selected(): string {
  return document.getSelection()?.toString() ?? ''
}

function cardOf(id: string): HTMLElement | null {
  return row(id)?.querySelector<HTMLElement>('.nrow-card') ?? null
}

async function openQuestion(detail = DETAIL): Promise<{ d: Database.Database, id: string }> {
  const d = freshDb()
  db = d
  const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Approve the rollout?', detail })
  await bootApp(d)
  await showInbox()
  click(row(id))
  await settle()
  expect(cardOf(id)?.querySelector('.card-tldr-body')?.textContent).toContain(DETAIL)
  return { d, id }
}

function arrive(d: Database.Database, title: string): string {
  advanceClock()
  return insertItem(d, { ...AGENT, kind: 'question', title })
}

describe('#223 · a text selection survives the 3-second rebuild', () => {
  it('CONTROL: a poll tick replaces the text node the selection lives in', async () => {
    const { d, id } = await openQuestion()
    const node = selectText(cardOf(id)?.querySelector('.card-tldr-body'), 'migration command')
    arrive(d, 'Unrelated arrival')

    await pollTick()

    expect(node.isConnected, 'the tick must rebuild the selected node, or the restore tests prove nothing').toBe(false)
  })

  it('restores the selection after an unrelated arrival rebuilds the inspector', async () => {
    const { d, id } = await openQuestion()
    selectText(cardOf(id)?.querySelector('.card-tldr-body'), 'migration command')
    const arrival = arrive(d, 'Unrelated arrival')

    await pollTick()

    expect(row(arrival), 'the arrival rendered, so the editable frame really rebuilt').not.toBeNull()
    expect(selected()).toBe('migration command')
    const selection = document.getSelection()!
    expect(selection.anchorNode?.isConnected).toBe(true)
    expect(cardOf(id)?.contains(selection.anchorNode ?? null)).toBe(true)
  })

  it('keeps a backward selection that spans elements, in its direction', async () => {
    const { d, id } = await openQuestion()
    const card = cardOf(id)!
    const start = locate(card.querySelector('.card-title'), 'rollout')
    const end = locate(card.querySelector('.card-tldr-body'), 'migration')
    const selection = document.getSelection()!
    selection.setBaseAndExtent(end.node, end.offset + 'migration'.length, start.node, start.offset)
    const expected = selected()
    expect(expected).toMatch(/^rollout\?[\s\S]*migration$/)
    arrive(d, 'Unrelated arrival')

    await pollTick()

    expect(selected()).toBe(expected)
    const after = document.getSelection()!
    expect(after.anchorNode?.textContent).toContain('migration')
    expect(after.focusNode?.textContent).toContain('rollout')
  })

  it('restores a selection through the human repaint entry too', async () => {
    const { id } = await openQuestion()
    const node = selectText(cardOf(id)?.querySelector('.card-tldr-body'), 'canary deploy')

    await repaint()

    expect(node.isConnected).toBe(false)
    expect(selected()).toBe('canary deploy')
  })

  it('restores a list-row selection after a row above it leaves', async () => {
    const d = freshDb()
    db = d
    insertItem(d, { ...AGENT, kind: 'question', title: 'First question in the queue' })
    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'Second question in the queue' })
    await bootApp(d)
    await showInbox()
    const [above, kept] = [...document.querySelectorAll<HTMLElement>('#needsYouList .nrow[data-card-id]')]
    const id = kept!.dataset['cardId']!
    const title = kept!.querySelector('.nrow-title')!.textContent!
    const node = selectText(kept!.querySelector('.nrow-title'), title)
    advanceClock()
    resolveItem(d, above!.dataset['cardId']!)

    await pollTick()

    expect(node.isConnected).toBe(false)
    expect(document.querySelector('#needsYouList .nrow[data-card-id]')).toBe(row(id))
    expect(selected()).toBe(title)
    expect(row(id)?.contains(document.getSelection()!.anchorNode)).toBe(true)
  })

  it('drops the selection silently when its text changed', async () => {
    const d = freshDb()
    db = d
    upsertBoard(d, { ...AGENT, title: 'Rollout', rows: [{ label: 'ship', status: 'tracked', note: 'deploy the eu-west canary first' }] })
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    selectText(document.querySelector('#boards .note-line'), 'eu-west canary')
    expect(selected()).toBe('eu-west canary')
    const board = listBoards(d)[0]!
    advanceClock()
    upsertBoard(d, {
      ...AGENT,
      title: 'Rollout',
      expectedVersion: board.revision,
      rows: [{ label: 'ship', status: 'tracked', note: 'deploy the us-east canary first', revision: board.rows[0]!.revision }],
    })

    await pollTick()

    expect(document.querySelector('#boards .note-line')?.textContent).toBe('deploy the us-east canary first')
    expect(selected()).toBe('')
    expect(document.getSelection()!.isCollapsed).toBe(true)
  })

  it('drops a selection whole rather than leave it stretched over rebuilt text', async () => {
    const d = freshDb()
    db = d
    upsertBoard(d, { ...AGENT, title: 'Rollout', rows: [{ label: 'ship', status: 'tracked', note: 'deploy the eu-west canary first' }] })
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    const start = locate(document.getElementById('pageTitle'), document.getElementById('pageTitle')!.textContent!)
    const end = locate(document.querySelector('#boards .note-line'), 'eu-west')
    document.getSelection()!.setBaseAndExtent(start.node, 0, end.node, end.offset + 'eu-west'.length)
    expect(selected()).toContain('eu-west')
    const board = listBoards(d)[0]!
    advanceClock()
    upsertBoard(d, {
      ...AGENT,
      title: 'Rollout',
      expectedVersion: board.revision,
      rows: [{ label: 'ship', status: 'tracked', note: 'deploy the us-east canary first', revision: board.rows[0]!.revision }],
    })

    await pollTick()

    expect(document.querySelector('#boards .note-line')?.textContent).toContain('us-east')
    expect(selected()).toBe('')
  })

  it('drops the selection when its item leaves the view', async () => {
    const { d, id } = await openQuestion()
    selectText(cardOf(id)?.querySelector('.card-tldr-body'), 'migration command')
    advanceClock()
    resolveItem(d, id)

    await pollTick()

    expect(row(id)).toBeNull()
    expect(selected()).toBe('')
  })

  it('keeps ambient signals live while a selection is held', async () => {
    const { d, id } = await openQuestion()
    selectText(cardOf(id)?.querySelector('.card-tldr-body'), 'migration command')
    expect(badgeCount()).toBe(1)
    arrive(d, 'Second question')

    await pollTick()

    expect(badgeCount()).toBe(2)
    expect(tabCount('needsYou')).toBe('2')
    expect(selected()).toBe('migration command')
  })

  it('never freezes: arrivals keep rendering while one selection stays for many ticks', async () => {
    const { d, id } = await openQuestion()
    selectText(cardOf(id)?.querySelector('.card-tldr-body'), 'migration command')

    const arrivals: string[] = []
    for (let tick = 0; tick < 6; tick++) {
      arrivals.push(arrive(d, `Arrival ${tick}`))
      await pollTick()
      expect(row(arrivals.at(-1)!), `tick ${tick} did not render its arrival`).not.toBeNull()
      expect(selected(), `tick ${tick} lost the selection`).toBe('migration command')
    }
    expect(badgeCount()).toBe(7)
    expect(document.getElementById('pauseHint')?.textContent).toBe('')
  })

  it('restores a selection in a surface the ambient painter rebuilds', async () => {
    const d = freshDb()
    db = d
    upsertActivity(d, {
      session: 'live', ...AGENT, doing: 'Building the release dashboard', idle: false,
    })
    advanceClock(60_000)
    await bootApp(d)
    // #304: lanes update in place; the activity panel is still rebuilt by every paint.
    const node = selectText(document.querySelector('#dashboard .dashboard-activity-total'), '1m')
    arrive(d, 'A question')

    await pollTick()

    expect(badgeCount()).toBe(1)
    expect(node.isConnected, 'the ambient painter rebuilt the activity panel').toBe(false)
    expect(selected()).toBe('1m')
  })

  it('restores a selection an ambient repaint replaced while a draft holds the editable frame', async () => {
    const d = freshDb()
    db = d
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Approve the rollout?' })
    upsertActivity(d, {
      session: 'live', ...AGENT, doing: 'Building the release dashboard', idle: false,
    })
    advanceClock(60_000)
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    type(answerInput(id), 'half-typed answer')
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    const node = selectText(document.querySelector('#dashboard .dashboard-activity-total'), '1m')
    arrive(d, 'Second question')

    await pollTick()

    expect(document.getElementById('pauseHint')?.textContent, 'the draft must hold the editable frame').not.toBe('')
    expect(badgeCount()).toBe(2)
    expect(node.isConnected, 'the ambient painter rebuilt the activity panel').toBe(false)
    expect(selected()).toBe('1m')
  })

  it('leaves the caret in a reply box the repaint focused (Change answer)', async () => {
    // A button press keeps the page selection in Chromium, and focusing a text
    // field moves the selection into it. Re-applying the old highlight after the
    // repaint focused the reopened reply box would leave it with no caret.
    const d = freshDb()
    db = d
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Approve the rollout?', detail: DETAIL })
    replyItem(d, id, 'old answer')
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    selectText(cardOf(id)?.querySelector('.card-tldr-body'), 'migration command')

    click(buttonLabelled('Change answer', row(id)!))
    await settle()

    const reply = answerInput(id)!
    expect(reply.value).toBe('old answer')
    expect(document.activeElement).toBe(reply)
    expect([reply.selectionStart, reply.selectionEnd]).toEqual([reply.value.length, reply.value.length])
    expect(selected(), 'a highlight re-applied outside the focused reply box takes its caret').toBe('')
    expect(document.getSelection()!.isCollapsed).toBe(true)
  })

  it('restoring moves neither keyboard focus nor scroll', async () => {
    const { d, id } = await openQuestion()
    const help = document.getElementById('keyboardHelp')!
    help.focus()
    expect(document.activeElement).toBe(help)
    const scroller = cardOf(id)!.querySelector<HTMLElement>('.nrow-card-scroll')!
    scroller.scrollTop = 40
    window.scrollTo(0, 0)
    const scrollTo = vi.spyOn(window, 'scrollTo')
    const scrollBy = vi.spyOn(window, 'scrollBy')
    const reveal = vi.spyOn(Element.prototype, 'scrollIntoView')
    selectText(cardOf(id)?.querySelector('.card-tldr-body'), 'migration command')
    arrive(d, 'Unrelated arrival')

    await pollTick()

    expect(selected()).toBe('migration command')
    expect(document.activeElement).toBe(help)
    expect(cardOf(id)!.querySelector<HTMLElement>('.nrow-card-scroll')!.scrollTop).toBe(40)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(scrollBy).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
  })

  it('does not take focus in a background viewer', async () => {
    const { d, id } = await openQuestion()
    const before = buttonLabelled('Send', row(id)!)!
    before.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    selectText(cardOf(id)?.querySelector('.card-tldr-body'), 'migration command')
    arrive(d, 'Unrelated arrival')

    await pollTick()

    expect(selected()).toBe('migration command')
    expect(document.activeElement?.tagName).toBe('BODY')
  })
})
