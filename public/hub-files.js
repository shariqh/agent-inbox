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
// Where it is on, a click on a listed document's file link (a chip in a card's Links strip, or the link
// inline in a card's text) opens a copy on this Mac: the link carries the entity it belongs to
// (`data-hub-file-kind`, `data-hub-file-id`) and says "Open a copy on this Mac: <path>" in its title. Any
// other file keeps Copy path, and in the Links strip one line saying it opens only on the other Mac. The
// click itself is handled by public/link-open.js, the one handler for a file link, which asks `request(el)`
// and `open(request)` here and says what happened in its own status region. `open` sends `{ kind, id,
// path }` and nothing else: main fetches the file from the hub itself, which answers only for a path that
// card links. Every word reaches the DOM as textContent, or escaped in static markup.
import { esc } from './esc.js'

// the hub's list (src/remote-file.ts), compared in a test
export const HUB_FILE_EXTENSIONS = Object.freeze([
  '.md', '.markdown', '.txt', '.log', '.json', '.yaml', '.yml', '.csv', '.tsv', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
])
const LISTED = new Set(HUB_FILE_EXTENSIONS)
// the hub's allowed roots besides `~/` (src/remote-file.ts ALLOWED_ROOTS), compared in a test:
// system locations stay on the other Mac
export const HUB_FILE_ROOTS = Object.freeze(['/Users/', '/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'])
// item and row ids main accepts (electron/hub-files.cjs)
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const PATH_MAX = 4096
export const OPEN_COPY = 'Open a copy on this Mac'
export const ONLY_THERE = 'This file opens only on the other Mac.'

/** One sentence per refusal main can answer, said beside the link; anything else is HUB_FILE_FALLBACK. */
export const HUB_FILE_REFUSALS = Object.freeze({
  no_gesture: 'Click the file again.',
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
 * servablePath), so the button shows for exactly what the hub serves. Under `~/` or an allowed root, at most
 * 4,096 characters, no control character, no empty segment and none that starts with `.` (so no `.`,
 * no `..` and no hidden file or folder), its name ending in a listed extension. Main checks again.
 */
export function hubFileListed(path) {
  if (typeof path !== 'string' || path.length < 2 || path.length > PATH_MAX || CONTROL.test(path)) return false
  let body
  if (path.startsWith('~/')) body = path.slice(2)
  else if (HUB_FILE_ROOTS.some((root) => path.startsWith(root))) body = path.slice(1)
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
 * The attributes and the title a file link carries when a click opens its copy, or null: for a path
 * `hubFileListed` accepts and an entity `hubFileEntity` named. The title is `Open a copy on this Mac: <path>`.
 * `attrs` is escaped markup to put beside the link's own attributes.
 */
export function hubFileLinkAttrs(path, entity) {
  if (!hubFileListed(path) || entity === null || typeof entity !== 'object') return null
  if ((entity.kind !== 'item' && entity.kind !== 'row') || typeof entity.id !== 'string' || !ENTITY_ID.test(entity.id)) return null
  return { attrs: ` data-hub-file-kind="${esc(entity.kind)}" data-hub-file-id="${esc(entity.id)}"`, title: `${OPEN_COPY}: ${path}` }
}

/**
 * A file chip in another Mac's Inbox: the chip and its Copy path button as one group. A listed file's
 * chip opens its copy on a click (see hubFileLinkAttrs); for any other file the group is followed by the
 * line saying it opens only there. `chip(attrs, title)` and `copy` are source.js's own escaped markup;
 * the rest is escaped here.
 */
export function hubFileGroupHtml({ chip, copy, link, entity }) {
  const open = hubFileLinkAttrs(link.path, entity)
  const group = `<span class="link-file" role="group" aria-label="${esc(`File ${link.label}`)}">${open ? chip(open.attrs, open.title) : chip()}${copy}</span>`
  return open ? group : `<span class="hub-file">${group}<span class="hub-file-note hub-file-only">${esc(ONLY_THERE)}</span></span>`
}

export function installHubFiles({
  desk = () => globalThis.agentInboxDesk,
  onChange = () => {},
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

  const valid = (request) => {
    const { kind, id, path } = request ?? {}
    return (kind === 'item' || kind === 'row') && typeof id === 'string' && ENTITY_ID.test(id) && hubFileListed(path)
  }

  return {
    /** Whether a card's files open here as copies, from the last answer. */
    available: () => files,
    /** Resolves once the last ask has its answer. */
    ready: () => ready,
    /**
     * `{ kind, id, path }` for a file link that opens its copy on a click, else null: files open here, the
     * link carries an entity (hubFileLinkAttrs), an absolute listed path and no repository folder.
     */
    request(el) {
      if (!files || !el || !el.dataset) return null
      const { hubFileKind: kind, hubFileId: id, linkPath: path, linkRoot: root } = el.dataset
      if (root) return null
      const request = { kind, id, path }
      return valid(request) ? request : null
    },
    /**
     * One open: sends `{ kind, id, path }` through the bridge and answers `{ ok: true }`, or
     * `{ ok: false, message }` with the sentence to say (the fallback for a request that is not valid, a
     * missing bridge, a bridge that throws or an answer it does not understand). Never throws.
     */
    async open(request) {
      const api = bridge()
      if (!files || !api || !valid(request)) return { ok: false, message: HUB_FILE_FALLBACK }
      const { kind, id, path } = request
      let answer = null
      try {
        answer = await api.openFile({ kind, id, path })
      } catch {
        answer = null
      }
      if (answer !== null && typeof answer === 'object' && answer.ok === true) return { ok: true }
      return { ok: false, message: hubFileRefusal(answer?.reason) }
    },
  }
}
