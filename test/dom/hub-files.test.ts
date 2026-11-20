// @vitest-environment jsdom
// test/dom/hub-files.test.ts — #634, #645: public/hub-files.js, a card's file opened as a copy on the Mac
// that shows another Mac's Inbox. It asks `agentInboxDesk.filesAvailable()` once and again on each
// connection change; where main says yes, a listed file's chip and its inline link carry the entity and
// say "Open a copy on this Mac: <path>" in their title, any other file in the Links strip a line saying
// it opens on the other Mac; one click (public/link-open.js, the one click handler) sends
// `{ kind, id, path }` and nothing else, and what the person is told is said in the status region. The
// bridge is a stub of electron/remote-preload.cjs's; nothing opens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HUB_FILE_EXTENSIONS, HUB_FILE_FALLBACK, HUB_FILE_REFUSALS, ONLY_THERE, OPEN_COPY, hubFileEntity, hubFileGroupHtml, hubFileLinkAttrs, hubFileListed, hubFileRefusal,
  installHubFiles,
} from '../../public/hub-files.js'
import { initLinkOpening } from '../../public/link-open.js'
import { fileLinkHtml, linkStripHtml } from '../../public/source.js'
import { renderStructuredText } from '../../public/structured-text.js'

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
const groupFor = (entity: { kind: string; id: string } | null) => (link: { path?: string; label: string }, parts: { chip: (attrs?: string, title?: string | null) => string; copy: string }) =>
  (entity ? hubFileGroupHtml({ ...parts, link: link as { path: string; label: string }, entity }) : null)

// what app.js's textContext hands the text renderer for the item or row that owns it
const ownedBy = (entity: { kind: string; id: string } | null) => (entity ? (path: string) => hubFileLinkAttrs(path, entity) : null)

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
    // #645: the press is now a click on the file itself
    expect(HUB_FILE_REFUSALS.no_gesture).toBe('Click the file again.')
    expect(HUB_FILE_REFUSALS.busy).toBe('One moment: a file was just opened.')
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
    // hidden files and folders stay on the other Mac, and so does a path the hub's form rule refuses
    ['~/.ssh/config.json', false], ['/Users/owner/.config/gh/hosts.yml', false], ['/Users/owner/repo/.env.json', false],
    ['/Users/owner/repo/.git/HEAD.txt', false], ['/Users/owner/../etc/x.md', false], ['/Users//owner/a.md', false], ['/Users/owner/a\u0007.md', false],
    // system locations stay on the other Mac
    ['/etc/hosts.txt', false], ['/private/etc/x.json', false], ['/Library/Logs/x.log', false], ['/var/log/system.log', false],
    ['/Applications/X.app/Contents/Info.json', false], ['/private/tmp/a.md', true], ['/var/folders/ab/T/a.md', true], ['/Volumes/Disk/a.md', false],
  ])('%s may open as a copy: %s', (path, expected) => {
    expect(hubFileListed(path)).toBe(expected)
  })

  it('names an item or a plan row by kind and id; a plan or anything else is nothing', () => {
    expect(hubFileEntity(ITEM)).toEqual({ kind: 'item', id: ITEM.id })
    expect(hubFileEntity(ROW)).toEqual({ kind: 'row', id: 'r1' })
    for (const other of [{ id: 'b1', title: 'Plan', rows: [] }, { ...ITEM, id: 'a/b' }, { ...ROW, id: '' }, null, 'x']) expect(hubFileEntity(other)).toBeNull()
  })
})

describe('a file chip in another Mac\'s Inbox', () => {
  const entity = { kind: 'item' as const, id: ITEM.id }
  const chipOf = () => document.querySelector<HTMLButtonElement>('button[data-link-kind="file"]')!

  it('carries the entity and says Open a copy on this Mac in its title, and keeps Copy path as it is', () => {
    document.body.innerHTML = linkStripHtml([SPEC], { copyFiles: true, hubFiles: groupFor(entity) })
    const chip = chipOf()
    expect(chip.dataset).toMatchObject({ hubFileKind: 'item', hubFileId: ITEM.id, linkKind: 'file', linkPath: SPEC.path })
    expect(chip.title).toBe(`${OPEN_COPY}: ${SPEC.path}`)
    const copy = document.querySelector('[data-link-action="copy"]')!
    expect(copy.getAttribute('data-link-path')).toBe(SPEC.path)
    expect(copy.getAttribute('title')).toBe('Copy path')
    expect(document.querySelector('[data-link-action="reveal"]')).toBeNull()
    // the separate button, its listener's marker and its note are gone
    expect(document.querySelector('[data-hub-file-open], .hub-file-open, .hub-file-note, [data-hub-file-path]')).toBeNull()
    expect(document.querySelector('.link-file')?.getAttribute('role')).toBe('group')
    expect(document.body.textContent).not.toContain(ONLY_THERE)
  })

  it('names a plan row by its kind', () => {
    document.body.innerHTML = linkStripHtml([SPEC], { copyFiles: true, hubFiles: groupFor({ kind: 'row', id: 'r1' }) })
    expect(chipOf().dataset).toMatchObject({ hubFileKind: 'row', hubFileId: 'r1' })
  })

  it('gives a hidden file its chip, Copy path and the line, with today\'s title and no entity', () => {
    const hidden = { ...SPEC, key: 'file:~/.config/gh/hosts.yml', path: '~/.config/gh/hosts.yml', label: 'hosts.yml', title: '~/.config/gh/hosts.yml' }
    document.body.innerHTML = linkStripHtml([hidden], { copyFiles: true, hubFiles: groupFor(entity) })
    expect(chipOf().hasAttribute('data-hub-file-kind')).toBe(false)
    expect(chipOf().hasAttribute('data-hub-file-id')).toBe(false)
    expect(chipOf().title).toBe(`Copy path: ${hidden.path}`)
    expect(document.querySelector('[data-link-action="copy"]')).not.toBeNull()
    expect(document.querySelector('.hub-file-only')?.textContent).toBe(ONLY_THERE)
  })

  it('gives any other file its chip, Copy path and the line, never the entity', () => {
    document.body.innerHTML = linkStripHtml([SCRIPT], { copyFiles: true, hubFiles: groupFor(entity) })
    expect(chipOf().hasAttribute('data-hub-file-kind')).toBe(false)
    expect(chipOf().title).toBe(`Copy path: ${SCRIPT.path}`)
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
      expect(chipOf().hasAttribute('data-hub-file-kind')).toBe(false)
      expect(chipOf().title).toMatch(/^Copy path: /)
      expect(document.querySelector('.hub-file-only')).toBeNull()
      expect(document.querySelector('[data-link-action]')).toBeNull()
    }
  })

  it('escapes the path and the label: nothing in them becomes markup', () => {
    const hostile = { ...SPEC, path: '/Users/owner/"><img src=x onerror=alert(1)>.md', label: '<b>x</b>.md' }
    document.body.innerHTML = linkStripHtml([hostile], { copyFiles: true, hubFiles: groupFor(entity) })
    expect(document.querySelector('img, b')).toBeNull()
    expect(chipOf().dataset.linkPath).toBe(hostile.path)
    expect(chipOf().title).toBe(`${OPEN_COPY}: ${hostile.path}`)
  })

  it('writes no entity whose id is not one main accepts', () => {
    document.body.innerHTML = linkStripHtml([SPEC], { copyFiles: true, hubFiles: groupFor({ kind: 'item', id: 'a"><i>' }) })
    expect(document.querySelector('i')).toBeNull()
    expect(chipOf().hasAttribute('data-hub-file-id')).toBe(false)
    expect(chipOf().title).toBe(`Copy path: ${SPEC.path}`)
  })
})

describe('an inline file link in another Mac\'s Inbox', () => {
  const entity = { kind: 'item' as const, id: ITEM.id }
  const linkOf = () => document.querySelector<HTMLElement>('a[data-link-kind="file"]')!

  it('carries the entity and says Open a copy on this Mac in its title, beside its existing attributes', () => {
    document.body.innerHTML = renderStructuredText(`Read ${SPEC.path} please`, { hubFile: ownedBy(entity) })
    const link = linkOf()
    expect(link.dataset).toMatchObject({ hubFileKind: 'item', hubFileId: ITEM.id, linkKind: 'file', linkPath: SPEC.path })
    expect(link.title).toBe(`${OPEN_COPY}: ${SPEC.path}`)
    expect(link.getAttribute('role')).toBe('button')
    expect(link.getAttribute('tabindex')).toBe('0')
    expect(link.hasAttribute('href')).toBe(false)
  })

  it('does not, for an unlisted file, a repo-relative one, no owner, or a page with no hub files', () => {
    for (const [text, ctx] of [
      [`Run ${SCRIPT.path}`, { hubFile: ownedBy(entity) }],
      ['Read docs/spec.md', { hubFile: ownedBy(entity), root: '/repo' }],
      [`Read ${SPEC.path}`, { hubFile: null }],
      [`Read ${SPEC.path}`, {}],
      [`Read ${SPEC.path}`, { copyFiles: true }],
    ] as const) {
      document.body.innerHTML = renderStructuredText(text, ctx)
      expect(linkOf().hasAttribute('data-hub-file-kind')).toBe(false)
      expect(linkOf().hasAttribute('data-hub-file-id')).toBe(false)
      expect(linkOf().title).not.toContain(OPEN_COPY)
    }
    expect(linkOf().title).toBe(`Copy path: ${SPEC.path}`)
  })

  it('escapes what it writes, and writes no entity whose id is not one main accepts', () => {
    document.body.innerHTML = fileLinkHtml('/Users/owner/"><img src=x>.md', '<b>a.md</b>', 'title', false, null, ownedBy(entity))
    expect(document.querySelector('b, img')).toBeNull()
    expect(linkOf().dataset.linkPath).toBe('/Users/owner/"><img src=x>.md')
    document.body.innerHTML = fileLinkHtml('/Users/owner/a.md', 'a.md', 'title', false, null, ownedBy({ kind: 'item', id: 'x"><i>' }))
    expect(document.querySelector('i')).toBeNull()
    expect(linkOf().hasAttribute('data-hub-file-id')).toBe(false)
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

  it('adds no click listener of its own', async () => {
    const add = vi.spyOn(document, 'addEventListener')
    const files = installHubFiles({ desk: () => hubDesk() })
    await files.ready()
    expect(add).not.toHaveBeenCalled()
    add.mockRestore()
  })

  async function ready(desk = hubDesk()) {
    const files = installHubFiles({ desk: () => desk })
    await files.ready()
    return { desk, files }
  }
  const chipFor = (html: string) => {
    document.body.innerHTML = html
    return document.querySelector<HTMLElement>('[data-link-kind="file"]')!
  }

  it('reads a request from a link that names the entity and a listed path, and from nothing else', async () => {
    const { files } = await ready()
    const entity = { kind: 'item' as const, id: ITEM.id }
    expect(files.request(chipFor(linkStripHtml([SPEC], { hubFiles: groupFor(entity) })))).toEqual({ kind: 'item', id: ITEM.id, path: SPEC.path })
    expect(files.request(chipFor(renderStructuredText(`Read ${SPEC.path}`, { hubFile: ownedBy({ kind: 'row', id: 'r1' }) })))).toEqual({ kind: 'row', id: 'r1', path: SPEC.path })
    // no attributes, an unlisted path, a rooted link, a forged entity
    expect(files.request(chipFor(linkStripHtml([SPEC], {})))).toBeNull()
    expect(files.request(chipFor(linkStripHtml([SCRIPT], { hubFiles: groupFor(entity) })))).toBeNull()
    const forged = chipFor(linkStripHtml([SPEC], { hubFiles: groupFor(entity) }))
    forged.dataset.hubFileKind = 'board'
    expect(files.request(forged)).toBeNull()
    forged.dataset.hubFileKind = 'item'
    forged.dataset.hubFileId = 'a/b'
    expect(files.request(forged)).toBeNull()
    forged.dataset.hubFileId = ITEM.id
    forged.dataset.linkRoot = '/repo'
    expect(files.request(forged)).toBeNull()
    expect(files.request(null)).toBeNull()
  })

  it('reads no request while main has not said files open here', async () => {
    const { files } = await ready(hubDesk(false))
    expect(files.request(chipFor(linkStripHtml([SPEC], { hubFiles: groupFor({ kind: 'item', id: ITEM.id }) })))).toBeNull()
  })

  it('sends exactly { kind, id, path } and answers ok', async () => {
    const { desk, files } = await ready()
    expect(await files.open({ kind: 'item', id: ITEM.id, path: SPEC.path })).toEqual({ ok: true })
    expect(desk.openFile.mock.calls).toEqual([[{ kind: 'item', id: ITEM.id, path: SPEC.path }]])
  })

  it('answers a refusal as its sentence, and anything odd as the fallback', async () => {
    const { desk, files } = await ready()
    const request = { kind: 'item' as const, id: ITEM.id, path: SPEC.path }
    desk.openFile.mockResolvedValueOnce({ ok: false, reason: 'old_hub' })
    expect(await files.open(request)).toEqual({ ok: false, message: HUB_FILE_REFUSALS.old_hub })
    desk.openFile.mockResolvedValueOnce({ ok: false, reason: 'weird' })
    expect(await files.open(request)).toEqual({ ok: false, message: HUB_FILE_FALLBACK })
    desk.openFile.mockResolvedValueOnce(null)
    expect(await files.open(request)).toEqual({ ok: false, message: HUB_FILE_FALLBACK })
    desk.openFile.mockRejectedValueOnce(new Error('gone'))
    expect(await files.open(request)).toEqual({ ok: false, message: HUB_FILE_FALLBACK })
  })

  it('answers the fallback, and sends nothing, for a bad request or a bridge that has gone', async () => {
    const { desk, files } = await ready()
    for (const bad of [null, { kind: 'board', id: 'b', path: SPEC.path }, { kind: 'item', id: 'a/b', path: SPEC.path }, { kind: 'item', id: 'a', path: SCRIPT.path }]) {
      expect(await files.open(bad as never)).toEqual({ ok: false, message: HUB_FILE_FALLBACK })
    }
    expect(desk.openFile).not.toHaveBeenCalled()
    let present = true
    const files2 = installHubFiles({ desk: () => (present ? desk : undefined) })
    await files2.ready()
    present = false
    expect(await files2.open({ kind: 'item', id: ITEM.id, path: SPEC.path })).toEqual({ ok: false, message: HUB_FILE_FALLBACK })
  })
})

// The one click handler for a file link is link-open.js, which asks the hub files first.
describe('a click on a file link', () => {
  const entity = { kind: 'item' as const, id: ITEM.id }
  const status = () => document.getElementById('linkOpenStatus')!
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  })
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
    Reflect.deleteProperty(window, 'agentInboxLinks')
  })

  async function boot(html: string, { files = true, desk = hubDesk(files), links }: { files?: boolean; desk?: ReturnType<typeof hubDesk>; links?: unknown } = {}) {
    const hub = installHubFiles({ desk: () => desk })
    await hub.ready()
    document.body.innerHTML = html
    initLinkOpening({ documentRef: document, bridge: () => links as never, hubFiles: hub })
    await flush()
    return { desk, hub }
  }
  const inline = (text = `Read ${SPEC.path}`) => renderStructuredText(text, { hubFile: ownedBy(entity) })
  const chip = linkStripHtml([SPEC], { hubFiles: groupFor(entity) })
  const target = (selector = '[data-link-kind="file"]') => document.querySelector<HTMLElement>(selector)!

  it.each([['the chip', chip], ['the inline link', inline()]])('opens the copy once from %s, and copies nothing', async (_name, html) => {
    const { desk } = await boot(html)
    target().click()
    await flush()
    expect(desk.openFile.mock.calls).toEqual([[{ kind: 'item', id: ITEM.id, path: SPEC.path }]])
    expect(writeText).not.toHaveBeenCalled()
  })

  it('says Getting the file at once, and Opened a copy on this Mac once it answers, for the usual 2.6 seconds', async () => {
    const { desk } = await boot(inline())
    let release: (value: unknown) => void = () => {}
    desk.openFile.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    target().click()
    await flush()
    expect(status().textContent).toBe('Getting the file from the other Mac…')
    // it stays until the answer, however long
    vi.advanceTimersByTime(60_000)
    expect(status().textContent).toBe('Getting the file from the other Mac…')
    release({ ok: true })
    await flush()
    expect(status().textContent).toBe('Opened a copy on this Mac.')
    expect(status().dataset.state).toBe('success')
    vi.advanceTimersByTime(2599)
    expect(status().textContent).toBe('Opened a copy on this Mac.')
    vi.advanceTimersByTime(2)
    expect(status().textContent).toBe('')
  })

  it('says a refusal as its sentence in the error state for 6 seconds', async () => {
    const { desk } = await boot(chip)
    desk.openFile.mockResolvedValue({ ok: false, reason: 'no_gesture' })
    target().click()
    await flush()
    expect(status().textContent).toBe('Click the file again.')
    expect(status().dataset.state).toBe('error')
    vi.advanceTimersByTime(5999)
    expect(status().textContent).toBe('Click the file again.')
    vi.advanceTimersByTime(2)
    expect(status().textContent).toBe('')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('says the fallback sentence, and never copies the path, when openFile throws or answers oddly', async () => {
    const { desk } = await boot(chip)
    desk.openFile.mockRejectedValueOnce(new Error('gone'))
    target().click()
    await flush()
    expect(status().textContent).toBe(HUB_FILE_FALLBACK)
    expect(status().dataset.state).toBe('error')
    desk.openFile.mockResolvedValueOnce(undefined)
    target().click()
    await flush()
    expect(status().textContent).toBe(HUB_FILE_FALLBACK)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('ignores a second click on the same element while it runs, marking it busy until it answers', async () => {
    const { desk } = await boot(inline())
    let release: (value: unknown) => void = () => {}
    desk.openFile.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const link = target()
    link.click()
    link.click()
    await flush()
    expect(desk.openFile).toHaveBeenCalledTimes(1)
    expect(link.getAttribute('aria-busy')).toBe('true')
    release({ ok: true })
    await flush()
    expect(link.hasAttribute('aria-busy')).toBe(false)
    link.click()
    await flush()
    expect(desk.openFile).toHaveBeenCalledTimes(2)
  })

  it('does not throw when the link was repainted while it ran', async () => {
    const { desk } = await boot(inline())
    let release: (value: unknown) => void = () => {}
    desk.openFile.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const link = target()
    link.click()
    await flush()
    document.body.replaceChildren()
    expect(() => release({ ok: false, reason: 'busy' })).not.toThrow()
    await flush()
    expect(link.hasAttribute('aria-busy')).toBe(false)
  })

  it('opens with Enter and Space on the inline link, once each', async () => {
    const { desk } = await boot(inline())
    for (const key of ['Enter', ' ']) {
      target().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      await flush()
    }
    expect(desk.openFile).toHaveBeenCalledTimes(2)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('leaves the Copy path icon as it is: it copies and opens nothing', async () => {
    const { desk } = await boot(chip)
    target('[data-link-action="copy"]').click()
    await flush()
    expect(writeText).toHaveBeenCalledWith(SPEC.path)
    expect(status().textContent).toBe('Copied the path.')
    expect(desk.openFile).not.toHaveBeenCalled()
  })

  it.each([
    ['an unlisted file', linkStripHtml([SCRIPT], { hubFiles: groupFor(entity) }), SCRIPT.path],
    ['a file with no owner', linkStripHtml([SPEC], { hubFiles: groupFor(null) }), SPEC.path],
    ['an inline link with no owner', renderStructuredText(`Read ${SPEC.path}`, {}), SPEC.path],
    ['an inline unlisted file', renderStructuredText(`Run ${SCRIPT.path}`, { hubFile: ownedBy(entity) }), SCRIPT.path],
  ])('copies the path of %s, with the line saying it opens only on the other Mac', async (_name, html, path) => {
    const { desk } = await boot(html)
    target().click()
    await flush()
    expect(writeText).toHaveBeenCalledWith(path)
    expect(status().textContent).toBe(`Copied the path. ${ONLY_THERE}`)
    expect(desk.openFile).not.toHaveBeenCalled()
  })

  it('copies a repo-relative file\'s full path, with the line', async () => {
    const relative = { ...SPEC, key: 'file:/repo/docs/spec.md', path: 'docs/spec.md', root: '/repo' }
    const { desk } = await boot(linkStripHtml([relative], { hubFiles: groupFor(entity) }))
    target().click()
    await flush()
    expect(writeText).toHaveBeenCalledWith('/repo/docs/spec.md')
    expect(status().textContent).toBe(`Copied the path. ${ONLY_THERE}`)
    expect(desk.openFile).not.toHaveBeenCalled()
  })

  it('keeps today\'s note where hub files are not available, and a browser unchanged', async () => {
    const { desk } = await boot(linkStripHtml([SPEC], { copyFiles: true }), { files: false })
    target().click()
    await flush()
    expect(writeText).toHaveBeenCalledWith(SPEC.path)
    expect(status().textContent).toBe('Copied the path. Files open only in Agent Inbox’s own window.')
    expect(desk.openFile).not.toHaveBeenCalled()
  })

  it('in the app\'s own window, opens the file locally through agentInboxLinks and never calls openFile', async () => {
    const open = vi.fn(async () => ({ ok: true, action: 'opened' }))
    const links = { open, filesAvailable: async () => true }
    const { desk } = await boot(linkStripHtml([SPEC], { copyFiles: false }), { files: false, links })
    target().click()
    await flush()
    expect(open).toHaveBeenCalledWith({ kind: 'file', path: SPEC.path, reveal: false })
    expect(desk.openFile).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('asks the hub files first even when a links bridge is present, and never both', async () => {
    const open = vi.fn(async () => ({ ok: true, action: 'opened' }))
    const { desk } = await boot(chip, { links: { open, filesAvailable: async () => true } })
    target().click()
    await flush()
    expect(desk.openFile).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })

  it('adds one click listener per document, and does not stop a click\'s propagation', async () => {
    const { desk } = await boot(chip)
    const seen = vi.fn()
    document.body.addEventListener('click', seen)
    target().click()
    await flush()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(desk.openFile).toHaveBeenCalledTimes(1)
    document.body.removeEventListener('click', seen)
  })
})
