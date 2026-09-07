const CLICK_ROLES = new Set(['button', 'link', 'tab', 'option', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem'])
const FOCUS_ROLES = new Set(['separator', 'slider', 'spinbutton', 'textbox', 'searchbox', 'combobox', 'listbox'])
const SELECTOR = [
  'button', 'a[href]', 'input', 'select', 'textarea', 'summary', '[tabindex]', '[contenteditable]',
  ...[...CLICK_ROLES, ...FOCUS_ROLES].map((role) => `[role~="${role}"]`),
].join(',')
const CLICK_INPUTS = new Set(['button', 'submit', 'reset', 'image', 'checkbox', 'radio'])
const NATIVE_KEYS = new Set(['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])
const TRANSIENT_CLASSES = new Set(['active', 'selected', 'is-active', 'is-selected', 'focused', 'is-focused', 'hover'])
const DECORATION_DATA = new Set(['data-shortcut', 'data-shortcut-id', 'data-open', 'data-tablist', 'data-sig', 'data-updating'])
const ACTION_ATTRIBUTES = new Set(['id', 'role', 'type', 'name', 'title', 'href', 'xlink:href', 'target', 'download', 'rel', 'form', 'formaction', 'formmethod', 'formtarget', 'aria-label', 'aria-labelledby', 'aria-controls', 'aria-haspopup', 'aria-expanded', 'aria-pressed', 'aria-checked'])
const IDENTITY_DATA = /^data-(?:(?:.*-)?(?:id|key|owner)|project|repo|stream|tab|action-filter|changed-filter|search-target|flow-target|dashboard-target)$/
const VERSION_DATA = /^data-.*(?:revision|version|updated-at|stamp)$/

function decorationData(name) {
  return DECORATION_DATA.has(name) || /^data-keyboard(?:-|$)/.test(name)
}

function editorHost(element) {
  for (let node = element; node; node = node.parentElement) {
    const editable = node.getAttribute('contenteditable')?.toLowerCase()
    if (editable === 'false') return null
    if (editable === '' || editable === 'true' || editable === 'plaintext-only') return node
  }
  return null
}

function nativeOwner(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement
  return !!element && (!!element.closest('input, select, textarea') || !!editorHost(element)
    || !!element.closest('[role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]'))
}

function actionKind(element) {
  const tag = element.localName
  const editor = editorHost(element)
  if (editor) return editor === element ? 'focus' : null
  if (tag === 'input') return element.type === 'hidden' ? null : CLICK_INPUTS.has(element.type) ? 'click' : 'focus'
  if (tag === 'select' || tag === 'textarea') return 'focus'
  if (tag === 'option' || tag === 'optgroup') return null
  if (tag === 'button' || (tag === 'a' && element.hasAttribute('href'))) return 'click'
  if (tag === 'summary' && element.parentElement?.localName === 'details'
    && [...element.parentElement.children].find((child) => child.localName === 'summary') === element) return 'click'
  const roles = (element.getAttribute('role') ?? '').split(/\s+/)
  if (roles.some((role) => CLICK_ROLES.has(role))) return 'click'
  if (roles.some((role) => FOCUS_ROLES.has(role)) && element.hasAttribute('tabindex')) return 'focus'
  return element.hasAttribute('tabindex') && element.tabIndex >= 0 ? 'focus' : null
}

function inScope(element, scope) {
  return !!scope && element.isConnected && (scope.nodeType === 9
    ? element.ownerDocument === scope && scope.documentElement.contains(element)
    : scope.isConnected && scope.contains(element))
}

function describe(element, kind) {
  const lineage = []
  let stable = !!element.id || (element.localName === 'a' && element.hasAttribute('href'))
  for (let node = element; node; node = node.parentElement) {
    const attributes = [...node.attributes]
      .filter(({ name }) => !decorationData(name) && (name === 'id' || IDENTITY_DATA.test(name) || VERSION_DATA.test(name)))
      .map(({ name, value }) => [name, value])
      .sort(([a], [b]) => a.localeCompare(b))
    if (attributes.length) lineage.push([node.localName, attributes])
    if (attributes.some(([name, value]) => IDENTITY_DATA.test(name) && value)) stable = true
  }
  const attributes = [...element.attributes]
    .filter(({ name }) => ACTION_ATTRIBUTES.has(name) || (name.startsWith('data-') && !decorationData(name)))
    .map(({ name, value }) => [name, value])
    .sort(([a], [b]) => a.localeCompare(b))
  const labelledBy = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
  const labels = [...(element.labels ?? [])].map((label) => label.textContent)
  const classes = [...element.classList].filter((name) => !TRANSIENT_CLASSES.has(name)).sort()
  const value = kind === 'click' && 'value' in element ? element.value : null
  const checked = 'checked' in element ? element.checked : null
  const href = element.localName === 'a'
    ? [element.ownerDocument.baseURI, typeof element.href === 'string' ? element.href : element.href?.baseVal]
    : null
  return {
    stable,
    fingerprint: JSON.stringify([lineage, element.namespaceURI, element.localName, kind, attributes,
      classes, element.textContent, labelledBy, labels, value, checked, href]),
  }
}

function logicalScopeIdentity(scope) {
  if (scope.nodeType !== 1) return null
  const owner = scope.closest('[data-key-hint-owner]')
  const identity = owner?.getAttribute('data-key-hint-owner')
  const version = owner?.getAttribute('data-key-hint-version')
  if (!identity || !version) return null
  return JSON.stringify([
    identity, version, scope.namespaceURI, scope.localName, scope.id,
    scope.getAttribute('role'), scope.getAttribute('aria-modal'),
    [...scope.classList].filter((name) => !TRANSIENT_CLASSES.has(name)).sort(),
  ])
}

function viewport(document) {
  const view = document.defaultView
  const visual = view.visualViewport
  const left = visual?.offsetLeft ?? 0
  const top = visual?.offsetTop ?? 0
  return {
    left, top,
    right: left + (visual?.width || document.documentElement.clientWidth || view.innerWidth),
    bottom: top + (visual?.height || document.documentElement.clientHeight || view.innerHeight),
  }
}

function containingBlock(style, position) {
  return (position === 'absolute' && !!style.position && style.position !== 'static')
    || ['transform', 'perspective', 'filter', 'backdropFilter'].some((key) => style[key] && style[key] !== 'none')
    || /\b(layout|paint|strict|content)\b/.test(style.contain)
    || /\b(transform|perspective|filter)\b/.test(style.willChange)
}

function visibilityReader(document) {
  const styles = new Map()
  const bounds = new Map()
  const screen = viewport(document)
  const styleOf = (element) => {
    if (!styles.has(element)) styles.set(element, document.defaultView.getComputedStyle(element))
    return styles.get(element)
  }
  const boundsOf = (element) => {
    if (!bounds.has(element)) bounds.set(element, element.getBoundingClientRect())
    return bounds.get(element)
  }
  return (element) => {
    if (!element.isConnected || element.closest('.key-hints-layer, [data-key-hints-ignore], [hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]')
      || element.matches(':disabled')) return null
    const ownStyle = styleOf(element)
    if (['hidden', 'collapse'].includes(ownStyle.visibility) || ownStyle.pointerEvents === 'none') return null
    const clips = []
    let escaping = ['fixed', 'absolute'].includes(ownStyle.position) ? ownStyle.position : null
    for (let node = element; node; node = node.parentElement) {
      const style = styleOf(node)
      if (style.display === 'none' || style.opacity === '0' || style.contentVisibility === 'hidden') return null
      if (node.localName === 'dialog' && !node.hasAttribute('open')) return null
      if (node.localName === 'details' && !node.hasAttribute('open')) {
        const summary = [...node.children].find((child) => child.localName === 'summary')
        if (!summary?.contains(element)) return null
      }
      if (node === element) continue
      if (escaping && containingBlock(style, escaping)) escaping = null
      if (!escaping) {
        const paint = /\b(paint|strict|content)\b/.test(style.contain)
        const x = paint || /^(hidden|clip|scroll|auto)$/.test(style.overflowX || style.overflow)
        const y = paint || /^(hidden|clip|scroll|auto)$/.test(style.overflowY || style.overflow)
        if (x || y) clips.push({ box: boundsOf(node), x, y })
      }
      // A fixed inspector can live inside an overflow-clipped queue row without
      // inheriting that row's clipping; a transformed containing block is different.
      if (['fixed', 'absolute'].includes(style.position)) escaping = style.position
    }
    for (const box of element.getClientRects()) {
      if (![box.left, box.right, box.top, box.bottom].every(Number.isFinite)) continue
      const visible = {
        left: Math.max(box.left, screen.left), right: Math.min(box.right, screen.right),
        top: Math.max(box.top, screen.top), bottom: Math.min(box.bottom, screen.bottom),
      }
      for (const clip of clips) {
        if (clip.x) { visible.left = Math.max(visible.left, clip.box.left); visible.right = Math.min(visible.right, clip.box.right) }
        if (clip.y) { visible.top = Math.max(visible.top, clip.box.top); visible.bottom = Math.min(visible.bottom, clip.box.bottom) }
      }
      if (visible.right - visible.left < 1 || visible.bottom - visible.top < 1) continue
      const padX = Math.min(2, (visible.right - visible.left) / 2)
      const padY = Math.min(2, (visible.bottom - visible.top) / 2)
      const xs = [visible.left + padX, (visible.left + visible.right) / 2, visible.right - padX]
      const ys = [visible.top + padY, (visible.top + visible.bottom) / 2, visible.bottom - padY]
      for (const y of ys) {
        for (const x of xs) {
          if (typeof document.elementFromPoint === 'function') {
            const hit = document.elementFromPoint(x, y)
            if (!hit || !element.contains(hit)) continue
            let nestedAction = false
            for (let node = hit; node && node !== element; node = node.parentElement) {
              if (node.matches(SELECTOR) && actionKind(node)) { nestedAction = true; break }
            }
            if (nestedAction) continue
          }
          return { x, y }
        }
      }
    }
    return null
  }
}

function codeAt(index, length) {
  let code = ''
  for (let i = 0; i < length; i++) {
    code = String.fromCharCode(65 + index % 26) + code
    index = Math.floor(index / 26)
  }
  return code
}

export function createKeyHints({ getScope = () => globalThis.document, onChange = () => {}, onAnnounce = () => {} } = {}) {
  let active = false
  let destroyed = false
  let scope = null
  let scopeIdentity = null
  let document = null
  let view = null
  let layer = null
  let observer = null
  let resizeObserver = null
  let frame = null
  let prefix = ''
  let codeLength = 2
  let issued = 0
  let capacityReached = false
  const entries = new Map()
  const observed = new Set()

  function readScope() {
    const next = getScope()
    if (!next || ![1, 9].includes(next.nodeType) || !next.isConnected) return null
    if (document && (next.nodeType === 9 ? next : next.ownerDocument) !== document) return null
    return next
  }

  function retire(entry) {
    entry.badge?.remove()
    entry.badge = null
    entry.element = null
    entry.retired = true
  }

  function collect() {
    if (!scope) return { candidates: [], counts: new Map() }
    const nodes = [...scope.querySelectorAll(SELECTOR)]
    if (scope.nodeType === 1 && scope.matches(SELECTOR)) nodes.unshift(scope)
    const visible = visibilityReader(document)
    const counts = new Map()
    const candidates = []
    for (const element of nodes) {
      if (element.closest('.key-hints-layer, [data-key-hints-ignore]')) continue
      const kind = actionKind(element)
      if (!kind) continue
      const identity = describe(element, kind)
      // Count hidden/disabled lookalikes too: visibility alone cannot establish a
      // unique identity for rebinding a removed action to a replacement node.
      counts.set(identity.fingerprint, (counts.get(identity.fingerprint) ?? 0) + 1)
      const point = visible(element)
      if (point) candidates.push({ element, kind, point, ...identity })
    }
    return { candidates, counts }
  }

  function paintPrefix() {
    for (const entry of entries.values()) {
      if (!entry.badge) continue
      const match = !!prefix && entry.code.startsWith(prefix)
      const dim = !!prefix && !match
      if (entry.badge.classList.contains('is-match') !== match) entry.badge.classList.toggle('is-match', match)
      if (entry.badge.classList.contains('is-dim') !== dim) entry.badge.classList.toggle('is-dim', dim)
    }
  }

  function syncResizeTargets(candidates) {
    if (!resizeObserver) return
    const targets = new Set(candidates.map(({ element }) => element))
    targets.add(scope?.nodeType === 1 ? scope : document.documentElement)
    for (const target of observed) {
      if (!targets.has(target)) { resizeObserver.unobserve(target); observed.delete(target) }
    }
    for (const target of targets) {
      if (!observed.has(target)) { resizeObserver.observe(target); observed.add(target) }
    }
  }

  function update({ candidates, counts }) {
    const byElement = new Map(candidates.map((candidate) => [candidate.element, candidate]))
    const byFingerprint = new Map(candidates.map((candidate) => [candidate.fingerprint, candidate]))
    const claimed = new Set()
    const missing = []
    const assign = (entry, candidate) => {
      entry.element = candidate.element
      entry.point = candidate.point
      entry.rebindable &&= counts.get(candidate.fingerprint) === 1
      claimed.add(candidate.element)
    }
    for (const entry of entries.values()) {
      if (entry.retired) continue
      const candidate = byElement.get(entry.element)
      if (candidate?.fingerprint === entry.fingerprint) assign(entry, candidate)
      else missing.push(entry)
    }
    for (const entry of missing) {
      const candidate = entry.rebindable && !entry.element.isConnected && counts.get(entry.fingerprint) === 1
        ? byFingerprint.get(entry.fingerprint) : null
      if (candidate && !claimed.has(candidate.element)) assign(entry, candidate)
      else retire(entry)
    }
    let limited = false
    for (const candidate of candidates) {
      if (claimed.has(candidate.element)) continue
      if (issued >= 26 ** codeLength) { limited = true; continue }
      const code = codeAt(issued++, codeLength)
      entries.set(code, {
        ...candidate, code, retired: false, badge: null,
        rebindable: candidate.stable && counts.get(candidate.fingerprint) === 1,
      })
    }
    const fragment = document.createDocumentFragment()
    for (const entry of entries.values()) {
      if (entry.retired || entry.badge) continue
      const badge = document.createElement('span')
      badge.className = 'key-hint'
      badge.dataset.code = entry.code
      badge.textContent = entry.code
      badge.style.position = 'absolute'
      badge.style.pointerEvents = 'none'
      entry.badge = badge
      fragment.appendChild(badge)
    }
    layer.appendChild(fragment)
    const screen = viewport(document)
    const measurements = [...entries.values()].filter((entry) => entry.badge)
      .map((entry) => ({ entry, box: entry.badge.getBoundingClientRect() }))
    for (const { entry, box } of measurements) {
      const width = box.width || entry.code.length * 8 + 8
      const height = box.height || 20
      const left = `${Math.max(screen.left, Math.min(entry.point.x - 2, screen.right - width))}px`
      const top = `${Math.max(screen.top, Math.min(entry.point.y - 2, screen.bottom - height))}px`
      if (entry.badge.style.left !== left) entry.badge.style.left = left
      if (entry.badge.style.top !== top) entry.badge.style.top = top
    }
    paintPrefix()
    syncResizeTargets(candidates)
    if (limited && !capacityReached) onAnnounce('Key hint capacity reached. Close and reopen hints to include new controls.')
    capacityReached = limited
  }

  function refresh() {
    if (!active || destroyed) return
    if (frame !== null) { view.cancelAnimationFrame(frame); frame = null }
    const next = readScope()
    if (!next) { destroy(); return }
    const identity = logicalScopeIdentity(next)
    // A polled phone card is a new node, not a new view. Only detached,
    // explicitly versioned owners may preserve their scope across replacement.
    const equivalent = !scope.isConnected && identity !== null && identity === scopeIdentity
    const changed = next !== scope && !equivalent
    if (changed) {
      for (const entry of entries.values()) retire(entry)
    }
    scope = next
    scopeIdentity = identity
    if (!layer.isConnected) (document.body ?? document.documentElement).appendChild(layer)
    update(collect())
    // Connected view changes stay guarded so an unfinished code's next X/E/number
    // cannot fall through to app shortcuts. A disconnected root is teardown.
    if (changed) onAnnounce('The active view changed. Previous codes are unavailable; type a displayed code or press Escape.')
  }

  function scheduleRefresh() {
    if (!active || destroyed || frame !== null) return
    frame = view.requestAnimationFrame(() => { frame = null; refresh() })
  }

  function ownNode(node) {
    const element = node.nodeType === 1 ? node : node.parentElement
    return !!element?.closest('.key-hints-layer')
  }

  function onFocus(event) {
    if (nativeOwner(event.target)) close()
  }

  function observe() {
    observer = new view.MutationObserver((mutations) => {
      if (mutations.some((mutation) => {
        if (ownNode(mutation.target)) return false
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes]
        return !nodes.length || !nodes.every(ownNode)
      })) scheduleRefresh()
    })
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    if (typeof view.ResizeObserver === 'function') resizeObserver = new view.ResizeObserver(scheduleRefresh)
    document.addEventListener('scroll', scheduleRefresh, true)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('transitionend', scheduleRefresh, true)
    document.addEventListener('animationend', scheduleRefresh, true)
    document.fonts?.addEventListener('loadingdone', scheduleRefresh)
    view.addEventListener('resize', scheduleRefresh)
    view.visualViewport?.addEventListener('resize', scheduleRefresh)
    view.visualViewport?.addEventListener('scroll', scheduleRefresh)
  }

  function close() {
    if (!active) return
    active = false
    prefix = ''
    if (frame !== null) { view.cancelAnimationFrame(frame); frame = null }
    observer?.disconnect()
    resizeObserver?.disconnect()
    observer = null
    resizeObserver = null
    observed.clear()
    document.removeEventListener('scroll', scheduleRefresh, true)
    document.removeEventListener('focusin', onFocus)
    document.removeEventListener('transitionend', scheduleRefresh, true)
    document.removeEventListener('animationend', scheduleRefresh, true)
    document.fonts?.removeEventListener('loadingdone', scheduleRefresh)
    view.removeEventListener('resize', scheduleRefresh)
    view.visualViewport?.removeEventListener('resize', scheduleRefresh)
    view.visualViewport?.removeEventListener('scroll', scheduleRefresh)
    layer?.remove()
    layer = null
    entries.clear()
    onChange(false)
  }

  function toggle() {
    if (destroyed) return
    if (active) { close(); onAnnounce('Key hints off.'); return }
    // Resolve the default lazily so importing this module has no DOM side effects.
    document = null
    scope = readScope()
    if (!scope) { destroy(); return }
    document = scope.nodeType === 9 ? scope : scope.ownerDocument
    view = document.defaultView
    prefix = ''
    issued = 0
    capacityReached = false
    layer = document.createElement('div')
    layer.className = 'key-hints-layer'
    layer.setAttribute('aria-hidden', 'true')
    layer.style.position = 'fixed'
    layer.style.inset = '0'
    layer.style.pointerEvents = 'none'
    ;(document.body ?? document.documentElement).appendChild(layer)
    active = true
    onChange(true)
    if (!active || destroyed) return
    scope = readScope()
    if (!scope) { destroy(); return }
    scopeIdentity = logicalScopeIdentity(scope)
    const snapshot = collect()
    codeLength = snapshot.candidates.length > 26 ** 2 ? 3 : 2
    observe()
    update(snapshot)
    const count = [...entries.values()].filter((entry) => !entry.retired).length
    onAnnounce(count
      ? `${count} key hints. Type a ${codeLength === 2 ? 'two' : 'three'}-letter code. Backspace edits; Escape exits.${capacityReached ? ' Capacity reached; some controls have no code.' : ''}`
      : 'No visible controls in this view. Key hints remain on; press Escape to exit.')
  }

  function announcePrefix() {
    const matches = [...entries.values()].filter((entry) => !entry.retired && entry.code.startsWith(prefix)).length
    paintPrefix()
    onAnnounce(prefix
      ? `${prefix}: ${matches} matching controls. Backspace edits; Escape exits.`
      : 'Type a displayed letter code. Escape exits.')
  }

  function stale() {
    onAnnounce('That control changed or is no longer available. No action taken; type a displayed code or press Escape.')
  }

  function activate(entry) {
    if (!entry || entry.retired) { stale(); return }
    const target = entry.element
    const expectedScope = scope
    const valid = () => readScope() === expectedScope && inScope(target, expectedScope)
      && actionKind(target) === entry.kind && describe(target, entry.kind).fingerprint === entry.fingerprint
      && !!visibilityReader(document)(target)
    if (!valid()) { retire(entry); stale(); return }
    close()
    if (!valid()) { stale(); return }
    target.focus?.({ preventScroll: true })
    // Focus and the parent's onChange callback can synchronously rebuild or revise
    // an action. A MutationObserver cannot protect this final click boundary.
    if (!valid()) { stale(); return }
    if (entry.kind === 'click') {
      if (typeof target.click === 'function') target.click()
      else target.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }))
    }
  }

  function handleKey(event) {
    if (!active || destroyed) return false
    if (nativeOwner(event.target) || nativeOwner(document.activeElement)) { close(); return false }
    if (!readScope()) { destroy(); return true }
    if (event.isComposing || event.keyCode === 229 || ['Process', 'Dead', 'Unidentified'].includes(event.key)) {
      prefix = ''
      paintPrefix()
      onAnnounce('Composition ignored by key hints. Type a fresh code when composition ends, or press Escape.')
      return true
    }
    if (event.repeat) return true
    if (event.ctrlKey || event.metaKey || event.altKey || ['Control', 'Meta', 'Alt', 'AltGraph'].includes(event.key)) {
      close()
      return false
    }
    if (event.key === 'Shift') return true
    if (NATIVE_KEYS.has(event.key)) { close(); return false }
    if (event.key === 'Escape') { close(); onAnnounce('Key hints off.'); return true }
    if (event.key === 'Backspace') {
      prefix = prefix.slice(0, -1)
      announcePrefix()
      return true
    }
    if (!/^[a-z]$/i.test(event.key)) {
      prefix = ''
      paintPrefix()
      onAnnounce('Use a displayed letter code. Backspace edits; Escape exits.')
      return true
    }
    prefix += event.key.toUpperCase()
    if (prefix.length < codeLength) { announcePrefix(); return true }
    const code = prefix
    prefix = ''
    refresh()
    const entry = entries.get(code)
    if (entry) activate(entry)
    else { paintPrefix(); onAnnounce('No key hint matches that code. No action taken; type a displayed code.') }
    return true
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    close()
  }

  return { toggle, close, isActive: () => active, handleKey, refresh, destroy }
}
