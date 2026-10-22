// Opening the links a card shows (issue #300). One delegated listener per
// document, in the capture phase so a surface that stops a click's propagation
// (the inspector card does) cannot swallow it; it never stops propagation
// itself, and only prevents the default of a link it handles.
//
// In the desktop app every detected link goes to Electron main through the one
// preload method, window.agentInboxLinks.open(), and main decides what may
// open: a web link only after its own http(s) check, a file with its default
// app, and a folder, an app or anything that could run code is only shown in
// Finder. A modified click (⌘, ⇧, …) on a web link keeps its native behaviour,
// which main's window-open handler checks the same way.
//
// A browser has no such bridge. Web links keep their ordinary new-tab
// behaviour, and a file link copies its path, because a page cannot open a
// local file. In the desktop app a file chip also has Reveal and Copy path
// (part 2). Nothing here reaches attention, a badge or a count.
import { writeClipboard } from './structured-copy.js'

const BINDING = Symbol.for('agent-inbox.link-open')
const STATUS_MS = 2600
const NEVER_OPENED = new Set(['blocked', 'executable', 'special'])

const finderName = (platform) => (/^Mac/i.test(platform) ? 'Finder' : 'your file manager')

// The secondary actions a file chip gets, or null in a browser, which can
// neither reveal a file nor needs a second way to copy its path.
export function linkFileActions({
  bridge = () => globalThis.agentInboxLinks,
  platform = globalThis.navigator?.platform ?? '',
} = {}) {
  const found = bridge()
  if (!found || typeof found.open !== 'function') return null
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
    return NEVER_OPENED.has(result.reason)
      ? `Shown in ${finder}. Agent Inbox never opens apps, scripts or installers.`
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
function bind(documentRef, handlers) {
  const existing = documentRef[BINDING]
  if (existing) {
    existing.handlers = handlers
    return
  }
  const binding = { handlers }
  documentRef.addEventListener('click', (event) => binding.handlers.click(event), true)
  documentRef.addEventListener('keydown', (event) => binding.handlers.keydown(event), true)
  documentRef[BINDING] = binding
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
  const api = () => {
    const found = bridge()
    return found && typeof found.open === 'function' ? found : null
  }
  const open = async (links, request) => {
    let result
    try {
      result = await links.open(request)
    } catch {
      result = { ok: false, reason: 'failed' }
    }
    show(linkOpenMessage(result, request, { finder }), result && result.ok === true ? 'success' : 'error')
  }
  const copyPath = async (path, note) => {
    const copied = await writeClipboard(documentRef, path).catch(() => false)
    show(copied ? `Copied the path.${note}` : 'Couldn’t copy the path.', copied ? 'success' : 'error')
  }

  bind(documentRef, {
    click(event) {
      const links = api()
      const action = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-link-action]') : null
      if (action) {
        event.preventDefault()
        const path = action.dataset.linkPath
        if (!path) return
        if (action.dataset.linkAction === 'copy') void copyPath(path, '')
        else if (action.dataset.linkAction === 'reveal' && links) void open(links, { kind: 'file', path, reveal: true })
        return
      }
      const el = linkElement(event)
      if (!el) return
      if (el.dataset.linkKind === 'file') {
        event.preventDefault()
        const path = el.dataset.linkPath
        if (!path) return
        if (links) void open(links, { kind: 'file', path, reveal: false })
        else void copyPath(path, ' A browser can’t open local files.')
        return
      }
      if (!links || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const url = el.getAttribute('href')
      if (!url) return
      event.preventDefault()
      void open(links, { kind: 'web', url })
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
  })
}
