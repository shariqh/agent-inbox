// @vitest-environment jsdom
// test/dom/copy-on-select.test.ts
//
// Issue #222: an opt-in "Copy text when selected" setting. When it is on, a
// selection the human finishes in the viewer (mouse released, or a keyboard
// selection change that settles) goes to the clipboard through the same
// writeText-then-fallback path as the fenced-code Copy button, as the text the
// selection serializes to (what Cmd+C copies). Editors are excluded: selecting
// draft text to replace it must never overwrite the clipboard.
//
// jsdom performs no default actions, so these tests leave the selection exactly
// where the browser would have left it between mousedown and mouseup.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, click, freshDb, pollTick, row, settle, showInbox, type,
  useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(document, 'execCommand')
})

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const
const PREFERENCE = 'agent-inbox-copy-on-select'
const SOURCE = 'npm run migrate -- --dry-run\ncurl https://example.com/health'

function stubClipboard(writeText: (text: string) => Promise<void> = async () => undefined) {
  const spy = vi.fn(writeText)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: spy } })
  return spy
}

function locate(root: Element | null | undefined, needle: string): { node: Text, offset: number } {
  if (!root) throw new Error(`locate(): nothing to search for "${needle}"`)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const offset = (node as Text).data.indexOf(needle)
    if (offset >= 0) return { node: node as Text, offset }
  }
  throw new Error(`locate(): "${needle}" is not inside one text node`)
}

function selectText(root: Element | null | undefined, needle: string): void {
  const { node, offset } = locate(root, needle)
  document.getSelection()!.setBaseAndExtent(node, offset, node, offset + needle.length)
}

function mouse(target: Element, type: 'mousedown' | 'mouseup', button = 0): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button, detail: 1 }))
}

/** A drag over `needle`: press, the browser extends the selection, release. */
function dragSelect(root: Element | null | undefined, needle: string, button = 0): void {
  const target = locate(root, needle).node.parentElement!
  mouse(target, 'mousedown', button)
  selectText(root, needle)
  mouse(target, 'mouseup', button)
}

function key(target: Element, type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }))
}

function status(): HTMLElement | null {
  return document.getElementById('selectionCopyStatus')
}

function toggle(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('#setup input.copy-on-select-toggle')
}

function detail(id: string): Element | null {
  return row(id)?.querySelector('.nrow-card .card-tldr-body') ?? null
}

async function openQuestion(enabled: boolean, detailText = 'Run the migration command before the canary deploy.'): Promise<{ d: Database.Database, id: string }> {
  if (enabled) localStorage.setItem(PREFERENCE, 'true')
  const d = freshDb()
  db = d
  const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Approve the rollout?', detail: detailText })
  await bootApp(d)
  await showInbox()
  click(row(id))
  await settle()
  return { d, id }
}

describe('#222 · Copy text when selected', () => {
  it('is off by default, and the Settings toggle persists the choice', async () => {
    db = freshDb()
    await bootApp(db)
    click(document.getElementById('gear'))

    expect(toggle(), 'no Copy text when selected toggle in Settings').not.toBeNull()
    expect(toggle()!.closest('label')?.textContent).toContain('Copy text when selected')
    expect(toggle()!.checked).toBe(false)
    expect(localStorage.getItem(PREFERENCE)).toBeNull()

    click(toggle())
    expect(toggle()!.checked).toBe(true)
    expect(localStorage.getItem(PREFERENCE)).toBe('true')

    click(toggle())
    expect(localStorage.getItem(PREFERENCE)).toBe('false')
  })

  it('restores a saved choice at boot', async () => {
    localStorage.setItem(PREFERENCE, 'true')
    db = freshDb()
    await bootApp(db)
    click(document.getElementById('gear'))

    expect(toggle()!.checked).toBe(true)
  })

  it('copies a finished pointer selection and confirms it', async () => {
    const writeText = stubClipboard()
    const { id } = await openQuestion(true)

    dragSelect(detail(id), 'migration command')
    await settle()

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith('migration command')
    expect(status()?.textContent).toBe('Copied')
    expect(status()?.getAttribute('role')).toBe('status')
  })

  it('copies what the selection serializes to, so a whole code block matches its Copy button', async () => {
    const writeText = stubClipboard()
    const { id } = await openQuestion(true, ['Run locally:', '', '```sh', SOURCE, '```'].join('\n'))
    const code = row(id)!.querySelector('.nrow-card .structured-code code')!
    const target = code.firstChild as Text
    mouse(code, 'mousedown')
    document.getSelection()!.setBaseAndExtent(target, 0, target, target.length)
    mouse(code, 'mouseup')
    await settle()

    expect(document.getSelection()!.toString()).toBe(SOURCE)
    expect(writeText).toHaveBeenCalledWith(SOURCE)
  })

  it('writes non-breaking spaces as spaces, as Cmd+C does', async () => {
    const writeText = stubClipboard()
    const { id } = await openQuestion(true, 'Run the migration\u00a0command first.')

    dragSelect(detail(id), 'migration\u00a0command')
    await settle()

    expect(writeText).toHaveBeenCalledWith('migration command')
  })

  it('copies nothing while the setting is off', async () => {
    const writeText = stubClipboard()
    const { id } = await openQuestion(false)

    dragSelect(detail(id), 'migration command')
    await settle()

    expect(document.getSelection()!.toString()).toBe('migration command')
    expect(writeText).not.toHaveBeenCalled()
    expect(status()?.textContent ?? '').toBe('')
  })

  it('stops copying as soon as the toggle is turned off', async () => {
    const writeText = stubClipboard()
    const { id } = await openQuestion(true)
    click(document.getElementById('gear'))
    click(toggle())
    await showInbox()

    dragSelect(detail(id), 'migration command')
    await settle()

    expect(writeText).not.toHaveBeenCalled()
  })

  it('turning the setting off cancels a selection that is still settling', async () => {
    const writeText = stubClipboard()
    const { id } = await openQuestion(true)
    const body = detail(id)!
    key(body, 'keydown', { key: 'Shift', shiftKey: true })
    selectText(body, 'Run the')
    key(body, 'keyup', { key: 'Shift' })
    click(document.getElementById('gear'))
    click(toggle())

    await vi.advanceTimersByTimeAsync(1000)

    expect(toggle()!.checked).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('never copies while a reply box or the search field owns the selection', async () => {
    const writeText = stubClipboard()
    const { id } = await openQuestion(true)
    // A browser can report a Range document selection while a field is focused;
    // whatever it reports, the field's text belongs to the editor.
    const reply = answerInput(id)!
    type(reply, 'replace this sentence')
    reply.focus()
    mouse(reply, 'mousedown')
    reply.setSelectionRange(0, 7)
    selectText(detail(id), 'migration command')
    mouse(reply, 'mouseup')
    await settle()

    const search = document.getElementById('search') as HTMLInputElement
    search.focus()
    mouse(search, 'mousedown')
    selectText(detail(id), 'canary deploy')
    mouse(search, 'mouseup')
    await settle()

    expect(writeText).not.toHaveBeenCalled()
  })

  it('ignores clicks that leave the selection as it was, and secondary-button selections', async () => {
    const writeText = stubClipboard()
    const { id } = await openQuestion(true)
    dragSelect(detail(id), 'migration command')
    await settle()
    expect(writeText).toHaveBeenCalledOnce()

    const close = row(id)!.querySelector('.nrow-card-close')!
    mouse(close, 'mousedown')
    mouse(close, 'mouseup')
    await settle()
    document.getSelection()!.removeAllRanges()
    dragSelect(detail(id), 'canary deploy', 2)
    await settle()

    expect(writeText).toHaveBeenCalledOnce()
  })

  it('copies again when the same text is dragged over again', async () => {
    const writeText = stubClipboard()
    const { id } = await openQuestion(true)
    dragSelect(detail(id), 'migration command')
    await settle()
    const target = locate(detail(id), 'migration command').node.parentElement!
    mouse(target, 'mousedown')
    document.getSelection()!.collapse(target, 0)
    await vi.advanceTimersByTimeAsync(0)
    selectText(detail(id), 'migration command')
    mouse(target, 'mouseup')
    await settle()

    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('copies a double-click once, even when its first click finishes late', async () => {
    const writeText = stubClipboard()
    const { id } = await openQuestion(true)
    const target = locate(detail(id), 'migration').node.parentElement!

    mouse(target, 'mousedown')
    mouse(target, 'mouseup')
    mouse(target, 'mousedown')
    selectText(detail(id), 'migration')
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, detail: 2 }))
    await settle()

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith('migration')
  })

  it('copies a keyboard selection once it settles, not on every key', async () => {
    const writeText = stubClipboard()
    const { id } = await openQuestion(true)
    const body = detail(id)!
    key(body, 'keydown', { key: 'Shift', shiftKey: true })
    key(body, 'keydown', { key: 'ArrowRight', shiftKey: true })
    selectText(body, 'Run')
    key(body, 'keyup', { key: 'ArrowRight', shiftKey: true })
    await vi.advanceTimersByTimeAsync(100)
    key(body, 'keydown', { key: 'ArrowRight', shiftKey: true })
    selectText(body, 'Run the')
    key(body, 'keyup', { key: 'ArrowRight', shiftKey: true })
    await vi.advanceTimersByTimeAsync(100)
    expect(writeText).not.toHaveBeenCalled()

    key(body, 'keyup', { key: 'Shift' })
    await vi.advanceTimersByTimeAsync(1000)

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith('Run the')
  })

  it('does not copy again for keys that leave the selection alone, across a poll restore', async () => {
    const writeText = stubClipboard()
    const { d, id } = await openQuestion(true)
    dragSelect(detail(id), 'migration command')
    await settle()
    expect(writeText).toHaveBeenCalledOnce()

    const body = detail(id)!
    key(body, 'keydown', { key: 'Meta', metaKey: true })
    key(body, 'keydown', { key: 'c', metaKey: true })
    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'Unrelated arrival' })
    await pollTick()
    expect(document.getSelection()!.toString(), 'the poll restored the selection').toBe('migration command')
    key(document.body, 'keyup', { key: 'c', metaKey: true })
    key(document.body, 'keyup', { key: 'Meta' })
    await vi.advanceTimersByTimeAsync(1000)

    expect(writeText).toHaveBeenCalledOnce()
  })

  it('falls back when the Clipboard API rejects, and says so when nothing could copy', async () => {
    const writeText = stubClipboard(async () => { throw new DOMException('Denied', 'NotAllowedError') })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    const { id } = await openQuestion(true)

    dragSelect(detail(id), 'migration command')
    await settle()
    expect(writeText).toHaveBeenCalledOnce()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(status()?.textContent).toBe('Copied')
    expect(document.getSelection()!.toString(), 'the fallback keeps the selection').toBe('migration command')

    execCommand.mockReturnValue(false)
    dragSelect(detail(id), 'canary deploy')
    await settle()
    expect(status()?.textContent).toBe('Copy failed')
    expect(status()?.dataset['state']).toBe('error')
  })

  it('shows Copied briefly and does not rewrite it for a quick repeat', async () => {
    const writeText = stubClipboard()
    const { id } = await openQuestion(true)
    dragSelect(detail(id), 'migration command')
    await settle()
    const announced = status()!.firstChild
    expect(status()?.textContent).toBe('Copied')

    dragSelect(detail(id), 'canary deploy')
    await settle()
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(status()!.firstChild, 'rewriting the live region would announce it again').toBe(announced)

    await vi.advanceTimersByTimeAsync(5000)
    expect(status()?.textContent).toBe('')
    expect(buttonLabelled('Send', row(id)!)).not.toBeNull()
  })
})
