// Opening the links a card shows (issue #300). One delegated listener per
// document, in the capture phase so a surface that stops a click's propagation
// (the inspector card does) cannot swallow it; it never stops propagation
// itself, and only prevents the default of a link it handles.
//
// In the desktop app every detected link goes to Electron main through the one
// preload method, window.agentInboxLinks.open(), and main decides what may
// open: a web link only after its own http(s) check, a common document type
// with its default app, and a folder, an app, an alias, anything that could run
// code or any other type is only shown in Finder. A modified click (⌘, ⇧, …) on
// a web link keeps its native behaviour, which main's window-open handler
// checks the same way.
//
// Local files open only in the viewer the app itself started and proved it
// owns. agentInboxLinks.filesAvailable() says whether this page is that viewer,
// asked once per page load and again when Settings opens (and before copying
// instead, since a reload's re-proof can finish late); main refuses file
// requests from any other page whatever this module thinks. A browser has no
// bridge at all. In both, web links keep their ordinary behaviour and a file
// link copies its path instead, saying why, and its title says "Copy path"
// (fileLinksCopy(), read when cards are drawn). Only in that viewer does a file
// chip also get Reveal and Copy path (part 2, linkFileActions()). Nothing here
// reaches attention, a badge or a count.
import { writeClipboard } from './structured-copy.js'

const BINDING = Symbol.for('agent-inbox.link-open')
const STATUS_MS = 2600
const NEVER_OPENED = new Set(['blocked', 'executable', 'special'])
const BROWSER_NOTE = 'A browser can’t open local files.'
const UNOWNED_NOTE = 'File links open only in Agent Inbox’s own viewer.'

const finderName = (platform) => (/^Mac/i.test(platform) ? 'Finder' : 'your file manager')
const usableBridge = (found) => (found && typeof found.open === 'function' ? found : null)

// The secondary actions a file chip gets, or null where files do not open: in
// a browser, which can neither reveal a file nor needs a second way to copy
// its path, and in a viewer main has not said is its own.
export function linkFileActions({
  bridge = () => globalThis.agentInboxLinks,
  platform = globalThis.navigator?.platform ?? '',
  documentRef = globalThis.document,
} = {}) {
  if (!usableBridge(bridge()) || documentRef?.[BINDING]?.permission !== true) return null
  return { reveal: /^Mac/i.test(platform) ? 'Reveal in Finder' : 'Show in folder' }
}

function statusRegion(documentRef) {
  const existing = documentRef.getElementById('linkOpenStatus')
  if (existing) return existing
  const region = documentRef.createElement('div')
  region.id = 'linkOpenStatus'
  region.className = 'link-open-status'
  region.setAttribute('role', 'status')
  region.setAttribute('aria-live', 'polite')
  region.setAttribute('aria-atomic', 'true')
  documentRef.body?.appendChild(region)
  return region
}

// What to say once main has answered; '' when the app that opened speaks for
// itself.
export function linkOpenMessage(result, request, { finder = 'Finder' } = {}) {
  const name = request && request.kind === 'file' ? request.path : 'this link'
  if (result && result.ok === true) {
    if (result.action !== 'revealed') return ''
    if (result.reason === 'type') return `Shown in ${finder}: this type isn’t opened automatically.`
    return NEVER_OPENED.has(result.reason)
      ? `Shown in ${finder}. Agent Inbox never opens apps, scripts, installers or aliases.`
      : `Shown in ${finder}.`
  }
  const reason = result && typeof result.reason === 'string' ? result.reason : 'failed'
  if (reason === 'missing') return `Not found: ${name}`
  if (reason === 'app-missing') return 'The app chosen in Settings → Links is gone. Choose another there.'
  if (reason === 'app-refused') return 'Agent Inbox won’t open links with the app chosen in Settings → Links. Choose another there.'
  if (reason === 'inaccessible') return `Agent Inbox can’t read ${name}`
  if (reason === 'invalid') return `Agent Inbox can’t open ${name}`
  if (reason === 'unavailable') return 'Links can’t be opened from this window.'
  return `Couldn’t open ${name}`
}

// One set of listeners per document; a later viewer boot in the same document
// replaces the handlers they forward to instead of stacking another set.
function binding(documentRef) {
  const existing = documentRef[BINDING]
  if (existing) return existing
  const created = { handlers: null, permission: null, refresh: () => Promise.resolve(false) }
  documentRef.addEventListener('click', (event) => created.handlers?.click(event), true)
  documentRef.addEventListener('keydown', (event) => created.handlers?.keydown(event), true)
  documentRef[BINDING] = created
  return created
}

// Whether a file link copies its path here instead of opening: always in a
// browser, and in the app once main has said this page is not its own viewer.
export function fileLinksCopy({ documentRef = globalThis.document, bridge = () => globalThis.agentInboxLinks } = {}) {
  if (!usableBridge(bridge())) return true
  return documentRef?.[BINDING]?.permission === false
}

// Asks main again whether this page may open local files (Settings opening,
// as Setup does). Resolves with the answer.
export function refreshLinkPermission(documentRef = globalThis.document) {
  const bound = documentRef?.[BINDING]
  return bound ? bound.refresh() : Promise.resolve(false)
}

const linkElement = (event) => {
  const target = event.target
  return target && typeof target.closest === 'function' ? target.closest('[data-link-kind]') : null
}

export function initLinkOpening({
  documentRef = globalThis.document,
  bridge = () => globalThis.agentInboxLinks,
  finder = finderName(globalThis.navigator?.platform ?? ''),
} = {}) {
  if (!documentRef) return
  const region = statusRegion(documentRef)
  let timer = null
  const show = (message, state) => {
    clearTimeout(timer)
    region.textContent = message
    if (!message) {
      delete region.dataset.state
      return
    }
    region.dataset.state = state
    timer = setTimeout(() => {
      region.textContent = ''
      delete region.dataset.state
    }, STATUS_MS)
  }
  const api = () => usableBridge(bridge())
  const bound = binding(documentRef)
  // what this page may do is asked anew on every boot
  bound.permission = null
  let asking = null
  const readPermission = (links) => {
    if (!links || typeof links.filesAvailable !== 'function') {
      bound.permission = false
      return Promise.resolve(false)
    }
    const ask = Promise.resolve().then(() => links.filesAvailable()).then((value) => value === true, () => false)
    asking = ask
    return ask.then((permitted) => {
      if (asking === ask) bound.permission = permitted
      return permitted
    })
  }
  bound.refresh = () => readPermission(api())
  const send = async (links, request) => {
    try {
      return await links.open(request)
    } catch {
      return { ok: false, reason: 'failed' }
    }
  }
  const report = (result, request) => {
    show(linkOpenMessage(result, request, { finder }), result && result.ok === true ? 'success' : 'error')
  }
  const copyPath = async (path, note) => {
    const copied = await writeClipboard(documentRef, path).catch(() => false)
    show(copied ? `Copied the path.${note ? ` ${note}` : ''}` : 'Couldn’t copy the path.', copied ? 'success' : 'error')
  }
  // Opens (or, from a chip's Reveal, only reveals) a local file through main,
  // or copies its path where files do not open.
  const openFile = async (links, path, reveal) => {
    // a page told no asks again first: its reload's re-proof may have finished
    const permitted = bound.permission === true || await readPermission(links)
    if (!permitted) return copyPath(path, UNOWNED_NOTE)
    const request = { kind: 'file', path, reveal }
    const result = await send(links, request)
    if (result && result.ok === false && result.reason === 'unowned') {
      bound.permission = false
      return copyPath(path, UNOWNED_NOTE)
    }
    return report(result, request)
  }

  bound.handlers = {
    click(event) {
      const links = api()
      const action = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-link-action]') : null
      if (action) {
        event.preventDefault()
        const path = action.dataset.linkPath
        if (!path) return
        if (action.dataset.linkAction === 'copy') void copyPath(path, '')
        else if (action.dataset.linkAction === 'reveal' && links) void openFile(links, path, true)
        return
      }
      const el = linkElement(event)
      if (!el) return
      if (el.dataset.linkKind === 'file') {
        event.preventDefault()
        const path = el.dataset.linkPath
        if (!path) return
        if (links) void openFile(links, path, false)
        else void copyPath(path, BROWSER_NOTE)
        return
      }
      if (!links || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const url = el.getAttribute('href')
      if (!url) return
      event.preventDefault()
      const request = { kind: 'web', url }
      void send(links, request).then((result) => report(result, request))
    },
    // An inline file link is a role="button" anchor with no href, so Enter and
    // Space do not click it natively.
    keydown(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const el = linkElement(event)
      if (!el || el !== event.target || el.tagName === 'BUTTON' || el.dataset.linkKind !== 'file') return
      event.preventDefault()
      el.click()
    },
  }
  void bound.refresh()
}
