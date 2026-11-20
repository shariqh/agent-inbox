// A card's files from the Mac that shows another Mac's Inbox (#634; architecture notes in
// docs/architecture/remote-inbox.md, "Opening a card's files from another Mac").
//
// The same page runs on This Mac and inside the view that shows another Mac's Inbox (the hub). A
// card's file link names a path on the hub, so there it can only be copied, unless main says files
// open here: `window.agentInboxDesk.filesAvailable()` answers `{ files: true }` only for the hub's own
// page, in a connecting app that has this feature (electron/hub-files.cjs). This Mac's own bridge has
// no such member, and a browser has no bridge, so neither ever shows the button. The answer is asked
// once when the page loads and again on each `onConnection`; a change repaints through `onChange`.
//
// Where it is on, a listed document in a card's Links strip gets "Open a copy on this Mac" beside Copy
// path; any other file keeps Copy path and one line saying it opens only on the other Mac. A click
// sends `{ kind, id, path }` and nothing else: main fetches the file from the hub itself, which
// answers only for a path that card links. Every word reaches the DOM as textContent, or escaped in
// static markup.
import { esc } from './esc.js'

const BINDING = Symbol.for('agent-inbox.hub-files')
// the hub's list (src/remote-file.ts), compared in a test
export const HUB_FILE_EXTENSIONS = Object.freeze([
  '.md', '.markdown', '.txt', '.log', '.json', '.yaml', '.yml', '.csv', '.tsv', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
])
const LISTED = new Set(HUB_FILE_EXTENSIONS)
// item and row ids main accepts (electron/hub-files.cjs)
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const PATH_MAX = 4096
export const OPEN_COPY = 'Open a copy on this Mac'
export const ONLY_THERE = 'This file opens only on the other Mac.'
const OPENED = 'Opened'
const OPENED_MS = 1500
const SAID_MS = 6000

/** One sentence per refusal main can answer, said beside the link; anything else is HUB_FILE_FALLBACK. */
export const HUB_FILE_REFUSALS = Object.freeze({
  no_gesture: 'Press Open a copy on this Mac again.',
  busy: 'One moment: a file was just opened.',
  unreachable: 'The other Mac’s Inbox could not be reached. Try again.',
  old_hub: 'The other Mac runs an older Agent Inbox that can’t send files. Update it once on that Mac: Agent Inbox → Check for Updates…',
  refused: 'The other Mac didn’t accept this Mac’s request. Check that this Mac is still listed under Settings → Other devices there.',
  not_linked: 'This card no longer links that file.',
  not_a_document: 'Only documents and images open from the other Mac.',
  too_large: 'The file is larger than 25 MB.',
  not_found: 'The file isn’t there on the other Mac.',
  unreadable: 'The other Mac couldn’t read the file.',
  open_failed: 'The copy was saved, but no app opened it.',
})
export const HUB_FILE_FALLBACK = 'The file could not be opened.'

/** The sentence for a refusal word. */
export function hubFileRefusal(reason) {
  return typeof reason === 'string' && Object.hasOwn(HUB_FILE_REFUSALS, reason) ? HUB_FILE_REFUSALS[reason] : HUB_FILE_FALLBACK
}

/**
 * Whether a link's path may open as a copy: the hub's own rule (src/remote-file.ts linkedPathForm and
 * servablePath), so the button shows for exactly what the hub serves. Absolute or under `~/`, at most
 * 4,096 characters, no control character, no empty segment and none that starts with `.` (so no `.`,
 * no `..` and no hidden file or folder), its name ending in a listed extension. Main checks again.
 */
export function hubFileListed(path) {
  if (typeof path !== 'string' || path.length < 2 || path.length > PATH_MAX || CONTROL.test(path)) return false
  let body
  if (path.startsWith('~/')) body = path.slice(2)
  else if (path.startsWith('/')) body = path.slice(1)
  else return false
  if (body.split('/').some((segment) => segment === '' || segment.startsWith('.'))) return false
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && LISTED.has(name.slice(dot).toLowerCase())
}

/** `{ kind, id }` for an item or a plan row (the entities whose text the hub reads), else null. */
export function hubFileEntity(entity) {
  if (entity === null || typeof entity !== 'object' || typeof entity.id !== 'string' || !ENTITY_ID.test(entity.id)) return null
  if (typeof entity.label === 'string') return { kind: 'row', id: entity.id }
  if (Array.isArray(entity.rows)) return null
  return typeof entity.title === 'string' && typeof entity.kind === 'string' ? { kind: 'item', id: entity.id } : null
}

/**
 * A file chip in another Mac's Inbox: the chip and its Copy path button as one group, then "Open a
 * copy on this Mac" with the place its sentence goes, or, for a file off the list, the line saying it
 * opens only there. `chip` and `copy` are source.js's own escaped markup; the rest is escaped here.
 */
export function hubFileGroupHtml({ chip, copy, link, entity }) {
  const group = `<span class="link-file" role="group" aria-label="${esc(`File ${link.label}`)}">${chip}${copy}</span>`
  const tail = hubFileListed(link.path)
    ? `<button type="button" class="hub-file-open" data-hub-file-open data-hub-file-kind="${esc(entity.kind)}" data-hub-file-id="${esc(entity.id)}"` +
      ` data-hub-file-path="${esc(link.path)}" title="${esc('Fetch this file from the other Mac and open a copy here')}"` +
      ` aria-label="${esc(`${OPEN_COPY}: ${link.label}`)}">${esc(OPEN_COPY)}</button><span class="hub-file-note" role="status" hidden></span>`
    : `<span class="hub-file-note hub-file-only">${esc(ONLY_THERE)}</span>`
  return `<span class="hub-file">${group}${tail}</span>`
}

export function installHubFiles({
  desk = () => globalThis.agentInboxDesk,
  onChange = () => {},
  setTimeout: later = (fn, ms) => globalThis.setTimeout(fn, ms),
  documentRef = globalThis.document,
} = {}) {
  let files = false
  let asks = 0
  let ready = Promise.resolve()
  const bridge = () => {
    try {
      const api = desk()
      return api && typeof api.filesAvailable === 'function' && typeof api.openFile === 'function' ? api : null
    } catch {
      return null
    }
  }

  async function ask() {
    const mine = ++asks
    const api = bridge()
    let next = false
    try {
      const answer = api ? await api.filesAvailable() : null
      next = answer !== null && typeof answer === 'object' && answer.files === true
    } catch {
      next = false
    }
    // a later ask decides; an unchanged answer repaints nothing
    if (mine !== asks || next === files) return
    files = next
    try {
      onChange()
    } catch {
      // the page's own error
    }
  }

  const first = bridge()
  if (first) {
    ready = ask()
    if (typeof first.onConnection === 'function') {
      try {
        first.onConnection(() => { ready = ask() })
      } catch {
        // no change messages: the first answer stands
      }
    }
  }

  // the last word each button showed, so a timer never clears a newer one
  const shown = new WeakMap()
  function show(button, note, label, sentence, ms) {
    const token = (shown.get(button) ?? 0) + 1
    shown.set(button, token)
    button.textContent = label
    if (note) {
      note.textContent = sentence
      note.hidden = sentence === ''
    }
    if (!ms) return
    later(() => {
      if (shown.get(button) !== token) return
      button.textContent = OPEN_COPY
      if (note) {
        note.textContent = ''
        note.hidden = true
      }
    }, ms)
  }

  /** One open: the button is disabled while it runs, then says Opened, or the refusal is said beside it. */
  async function run(request, button, note) {
    const api = bridge()
    if (!files || !api || !button || button.disabled) return null
    const { kind, id, path } = request ?? {}
    if ((kind !== 'item' && kind !== 'row') || typeof id !== 'string' || !ENTITY_ID.test(id) || !hubFileListed(path)) return null
    button.disabled = true
    show(button, note, OPEN_COPY, '', 0)
    let answer = null
    try {
      answer = await api.openFile({ kind, id, path })
    } catch {
      answer = null
    }
    button.disabled = false
    if (answer !== null && typeof answer === 'object' && answer.ok === true) show(button, note, OPENED, '', OPENED_MS)
    else show(button, note, OPEN_COPY, hubFileRefusal(answer?.reason), SAID_MS)
    return answer
  }

  // one listener per document; a later install replaces what it forwards to
  if (documentRef) {
    let bound = documentRef[BINDING]
    if (!bound) {
      bound = { click: null }
      documentRef.addEventListener('click', (event) => bound.click?.(event), true)
      documentRef[BINDING] = bound
    }
    bound.click = (event) => {
      const button = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-hub-file-open]') : null
      if (!button) return
      event.preventDefault()
      const note = button.parentElement?.querySelector('.hub-file-note') ?? null
      void run({ kind: button.dataset.hubFileKind, id: button.dataset.hubFileId, path: button.dataset.hubFilePath }, button, note)
    }
  }

  return {
    /** Whether a card's files open here as copies, from the last answer. */
    available: () => files,
    /** Resolves once the last ask has its answer. */
    ready: () => ready,
    run,
  }
}
