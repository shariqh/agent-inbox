const COPY_BINDING = Symbol.for('agent-inbox.structured-text-copy')
const RESET_DELAY_MS = 2_000
const resetTimers = new WeakMap()

function resetAfter(element, callback) {
  const prior = resetTimers.get(element)
  if (prior) clearTimeout(prior)
  resetTimers.set(element, setTimeout(() => {
    callback()
    resetTimers.delete(element)
  }, RESET_DELAY_MS))
}

function restoreSelection(documentRef, active, ranges) {
  const selection = documentRef.getSelection?.()
  if (selection) {
    selection.removeAllRanges()
    for (const range of ranges) selection.addRange(range)
  }
  if (typeof active?.focus === 'function' && documentRef.contains(active)) {
    active.focus({ preventScroll: true })
  }
}

function legacyCopy(documentRef, source) {
  if (!documentRef.body || typeof documentRef.execCommand !== 'function') return false
  const active = documentRef.activeElement
  const selection = documentRef.getSelection?.()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []
  const textarea = documentRef.createElement('textarea')
  textarea.value = source
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.cssText = 'position:fixed;inset:0;opacity:0;pointer-events:none'
  let copied = false
  try {
    documentRef.body.appendChild(textarea)
    textarea.select()
    textarea.setSelectionRange(0, source.length)
    copied = documentRef.execCommand('copy') === true
  } catch {
    copied = false
  } finally {
    textarea.remove()
    restoreSelection(documentRef, active, ranges)
  }
  return copied
}

async function writeClipboard(documentRef, source) {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(source)
      return true
    } catch {
      // Permission denial falls through to the local selection-based fallback.
    }
  }
  return legacyCopy(documentRef, source)
}

function showStatus(button, announcer, message, state) {
  const status = button.closest('.structured-code')?.querySelector('.structured-code-status')
  if (status) {
    status.textContent = message
    status.dataset.state = state
    resetAfter(status, () => {
      status.textContent = ''
      delete status.dataset.state
    })
  }
  if (announcer) {
    const sequence = String(Number(announcer.dataset.sequence ?? '0') + 1)
    announcer.dataset.sequence = sequence
    announcer.textContent = ''
    queueMicrotask(() => {
      if (announcer.dataset.sequence !== sequence) return
      announcer.textContent = message
      resetAfter(announcer, () => { announcer.textContent = '' })
    })
  }
}

async function copyFromButton(button, documentRef, announcer) {
  let source
  try {
    source = JSON.parse(button.dataset.copySource ?? '')
  } catch {
    showStatus(button, announcer, 'Copy failed', 'error')
    return
  }
  if (typeof source !== 'string') {
    showStatus(button, announcer, 'Copy failed', 'error')
    return
  }
  const copied = await writeClipboard(documentRef, source)
  showStatus(button, announcer, copied ? 'Copied' : 'Copy failed', copied ? 'success' : 'error')
}

function copyAnnouncer(documentRef) {
  const existing = documentRef.getElementById('structured-copy-announcer')
  if (existing) return existing
  if (!documentRef.body) return null
  const announcer = documentRef.createElement('div')
  announcer.id = 'structured-copy-announcer'
  announcer.className = 'visually-hidden'
  announcer.setAttribute('role', 'status')
  announcer.setAttribute('aria-live', 'polite')
  announcer.setAttribute('aria-atomic', 'true')
  documentRef.body.appendChild(announcer)
  return announcer
}

export function initStructuredTextCopy(root = globalThis.document) {
  if (!root) return
  const documentRef = root.ownerDocument ?? root
  const existing = root[COPY_BINDING]
  if (existing) {
    existing.announcer = copyAnnouncer(documentRef)
    return
  }
  const binding = { announcer: copyAnnouncer(documentRef) }
  const onClick = (event) => {
    const button = event.target?.closest?.('button.structured-code-copy')
    if (!button || !root.contains(button)) return
    void copyFromButton(button, documentRef, binding.announcer)
  }
  root.addEventListener('click', onClick, true)
  root[COPY_BINDING] = binding
}
