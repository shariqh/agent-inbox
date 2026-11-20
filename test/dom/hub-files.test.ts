// @vitest-environment jsdom
// test/dom/hub-files.test.ts — #634: public/hub-files.js, a card's file opened as a copy on the Mac
// that shows another Mac's Inbox. It asks `agentInboxDesk.filesAvailable()` once and again on each
// connection change; where main says yes, a listed file in a card's Links strip gets "Open a copy on
// this Mac" beside Copy path, any other file only a line saying it opens on the other Mac; a click
// sends `{ kind, id, path }` and nothing else, and each refusal is one sentence beside the link. The
// bridge is a stub of electron/remote-preload.cjs's; nothing opens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HUB_FILE_EXTENSIONS, HUB_FILE_FALLBACK, HUB_FILE_REFUSALS, ONLY_THERE, OPEN_COPY, hubFileEntity, hubFileGroupHtml, hubFileListed, hubFileRefusal,
  installHubFiles,
} from '../../public/hub-files.js'
import { linkStripHtml } from '../../public/source.js'

const ITEM = { id: '6f1c2d3e-4a5b-4c6d-8e7f-001122334455', kind: 'note', title: 'Read the spec' }
const ROW = { id: 'r1', label: 'one', status: 'tracked' }
const SPEC = { kind: 'file' as const, key: 'file:/Users/owner/docs/spec.md', path: '/Users/owner/docs/spec.md', label: 'spec.md', title: '/Users/owner/docs/spec.md', own: false }
const SCRIPT = { ...SPEC, key: 'file:/Users/owner/run.sh', path: '/Users/owner/run.sh', label: 'run.sh', title: '/Users/owner/run.sh' }

function hubDesk(files = true) {
  let listener: ((value: unknown) => void) | null = null
  const desk = {
    answer: { files } as unknown,
    available: vi.fn(async () => ({ open: false })),
    open: vi.fn(),
    filesAvailable: vi.fn(async () => desk.answer),
    openFile: vi.fn(async (_request: { kind: string; id: string; path: string }): Promise<unknown> => ({ ok: true })),
    onConnection: vi.fn((callback: (value: unknown) => void) => { listener = callback; return () => { listener = null } }),
    emit: () => listener?.({ mode: 'hub', label: 'studio', state: 'online', version: '2.16.0' }),
  }
  return desk
}

// what app.js passes linkStripHtml: the group for one entity, or null
const groupFor = (entity: { kind: string; id: string } | null) => (link: { path?: string; label: string }, parts: { chip: string; copy: string }) =>
  (entity ? hubFileGroupHtml({ ...parts, link: link as { path: string; label: string }, entity }) : null)

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  document.body.replaceChildren()
})
afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('the words and the rules', () => {
  it('has one plain sentence per refusal main can answer, and a fallback for anything else', () => {
    expect(Object.keys(HUB_FILE_REFUSALS).sort()).toEqual(
      ['busy', 'no_gesture', 'not_a_document', 'not_found', 'not_linked', 'old_hub', 'open_failed', 'refused', 'too_large', 'unreachable', 'unreadable'],
    )
    // the update idea for an older hub, in a sentence of its own
    expect(HUB_FILE_REFUSALS.old_hub).toContain('Check for Updates')
    expect(HUB_FILE_REFUSALS.refused).not.toContain('Check for Updates')
    for (const reason of ['failed', 'unavailable', 'bad_request', 'toString', '__proto__', undefined, 7]) expect(hubFileRefusal(reason)).toBe(HUB_FILE_FALLBACK)
    expect(hubFileRefusal('too_large')).toBe(HUB_FILE_REFUSALS.too_large)
    expect(OPEN_COPY).toBe('Open a copy on this Mac')
    expect(ONLY_THERE).toBe('This file opens only on the other Mac.')
  })

  it('lists the same document types as the hub', () => {
    expect([...HUB_FILE_EXTENSIONS]).toEqual(['.md', '.markdown', '.txt', '.log', '.json', '.yaml', '.yml', '.csv', '.tsv', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp'])
  })

  it.each([
    ['/Users/owner/docs/spec.md', true], ['~/notes/a.TXT', true], ['/tmp/shot.png', true],
    ['/Users/owner/page.html', false], ['/Users/owner/icon.svg', false], ['/Users/owner/run.sh', false], ['/Users/owner/.md', false],
    ['docs/spec.md', false], ['', false], [7, false],
  ])('%s may open as a copy: %s', (path, expected) => {
    expect(hubFileListed(path)).toBe(expected)
  })

  it('names an item or a plan row by kind and id; a plan or anything else is nothing', () => {
    expect(hubFileEntity(ITEM)).toEqual({ kind: 'item', id: ITEM.id })
    expect(hubFileEntity(ROW)).toEqual({ kind: 'row', id: 'r1' })
    for (const other of [{ id: 'b1', title: 'Plan', rows: [] }, { ...ITEM, id: 'a/b' }, { ...ROW, id: '' }, null, 'x']) expect(hubFileEntity(other)).toBeNull()
  })
})

describe('the Links strip in another Mac\'s Inbox', () => {
  const entity = { kind: 'item' as const, id: ITEM.id }

  it('gives a listed file Copy path and Open a copy on this Mac, carrying the entity and the path', () => {
    document.body.innerHTML = linkStripHtml([SPEC], { copyFiles: true, hubFiles: groupFor(entity) })
    const open = document.querySelector<HTMLButtonElement>('[data-hub-file-open]')!
    expect(open.textContent).toBe(OPEN_COPY)
    expect(open.dataset).toMatchObject({ hubFileKind: 'item', hubFileId: ITEM.id, hubFilePath: SPEC.path })
    expect(document.querySelector('[data-link-action="copy"]')?.getAttribute('data-link-path')).toBe(SPEC.path)
    expect(document.querySelector('[data-link-action="reveal"]')).toBeNull()
    const note = document.querySelector<HTMLElement>('.hub-file-note')!
    expect(note.hidden).toBe(true)
  })

  it('gives any other file Copy path and one line saying it opens only on the other Mac', () => {
    document.body.innerHTML = linkStripHtml([SCRIPT], { copyFiles: true, hubFiles: groupFor(entity) })
    expect(document.querySelector('[data-hub-file-open]')).toBeNull()
    expect(document.querySelector('[data-link-action="copy"]')).not.toBeNull()
    expect(document.querySelector('.hub-file-only')?.textContent).toBe(ONLY_THERE)
  })

  it('keeps today\'s chip for a repo-relative file, for a link with no entity, and without the option', () => {
    const relative = { ...SPEC, key: 'file:/repo/docs/spec.md', path: 'docs/spec.md', root: '/repo' }
    for (const html of [
      linkStripHtml([relative], { copyFiles: true, hubFiles: groupFor(entity) }),
      linkStripHtml([SPEC], { copyFiles: true, hubFiles: groupFor(null) }),
      linkStripHtml([SPEC], { copyFiles: true }),
    ]) {
      document.body.innerHTML = html
      expect(document.querySelector('[data-hub-file-open]')).toBeNull()
      expect(document.querySelector('.hub-file-only')).toBeNull()
      expect(document.querySelector('[data-link-action]')).toBeNull()
    }
  })

  it('escapes the path and the entity: nothing in them becomes markup', () => {
    const hostile = { ...SPEC, path: '/Users/owner/"><img src=x onerror=alert(1)>.md', label: '<b>x</b>.md' }
    document.body.innerHTML = linkStripHtml([hostile], { copyFiles: true, hubFiles: groupFor({ kind: 'item', id: ITEM.id }) })
    expect(document.querySelector('img, b')).toBeNull()
    expect(document.querySelector<HTMLElement>('[data-hub-file-open]')!.dataset.hubFilePath).toBe(hostile.path)
  })
})

describe('installHubFiles', () => {
  it('asks filesAvailable() once at load and again on each connection change, and repaints on a change', async () => {
    const desk = hubDesk()
    const onChange = vi.fn()
    const files = installHubFiles({ desk: () => desk, onChange })
    await files.ready()
    expect(files.available()).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(1)
    desk.answer = { files: false }
    desk.emit()
    await files.ready()
    expect(files.available()).toBe(false)
    expect(desk.filesAvailable).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('offers nothing in a browser, on This Mac\'s own bridge, or with a bridge that throws', async () => {
    for (const desk of [() => undefined, () => ({ available: async () => ({ open: false }), connection: async () => ({ mode: 'local' }) }), () => { throw new Error('x') }]) {
      const files = installHubFiles({ desk: desk as never })
      await files.ready()
      expect(files.available()).toBe(false)
    }
    const odd = hubDesk()
    odd.answer = { files: 'yes' }
    const files = installHubFiles({ desk: () => odd })
    await files.ready()
    expect(files.available()).toBe(false)
  })

  const strip = () => {
    document.body.innerHTML = linkStripHtml([SPEC], { copyFiles: true, hubFiles: groupFor({ kind: 'item', id: ITEM.id }) })
    return {
      button: document.querySelector<HTMLButtonElement>('[data-hub-file-open]')!,
      note: document.querySelector<HTMLElement>('.hub-file-note')!,
    }
  }

  it('sends exactly { kind, id, path } on a click, disables the button while it runs, then says Opened', async () => {
    const desk = hubDesk()
    let release: (value: unknown) => void = () => {}
    desk.openFile.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const files = installHubFiles({ desk: () => desk })
    await files.ready()
    const { button, note } = strip()
    button.click()
    expect(desk.openFile.mock.calls).toEqual([[{ kind: 'item', id: ITEM.id, path: SPEC.path }]])
    expect(button.disabled).toBe(true)
    // a second click while it runs sends nothing
    button.click()
    expect(desk.openFile).toHaveBeenCalledTimes(1)
    release({ ok: true })
    await flush()
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('Opened')
    expect(note.hidden).toBe(true)
    vi.advanceTimersByTime(1500)
    expect(button.textContent).toBe(OPEN_COPY)
  })

  it('says a refusal in one sentence beside the link, as text, for 6 seconds', async () => {
    const desk = hubDesk()
    desk.openFile.mockResolvedValue({ ok: false, reason: 'old_hub' })
    const files = installHubFiles({ desk: () => desk })
    await files.ready()
    const { button, note } = strip()
    button.click()
    await flush()
    expect(note.hidden).toBe(false)
    expect(note.textContent).toBe(HUB_FILE_REFUSALS.old_hub)
    expect(note.children).toHaveLength(0)
    expect(button.textContent).toBe(OPEN_COPY)
    vi.advanceTimersByTime(6000)
    expect(note.hidden).toBe(true)
    expect(note.textContent).toBe('')
  })

  it('reads a bridge that throws, or an odd answer, as the fallback sentence', async () => {
    const desk = hubDesk()
    desk.openFile.mockRejectedValue(new Error('gone'))
    const files = installHubFiles({ desk: () => desk })
    await files.ready()
    const { button, note } = strip()
    button.click()
    await flush()
    expect(note.textContent).toBe(HUB_FILE_FALLBACK)
  })

  it('does nothing for a click while main has not said files open here', async () => {
    const desk = hubDesk(false)
    const files = installHubFiles({ desk: () => desk })
    await files.ready()
    const { button } = strip()
    button.click()
    expect(desk.openFile).not.toHaveBeenCalled()
  })
})
