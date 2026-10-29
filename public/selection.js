// Text selections across the viewer's DOM rebuilds (issue #223).
//
// The 3-second poll replaces the list and inspector nodes. A live range follows
// removed nodes up to their parent and collapses there, so the human's highlight
// disappeared on the next tick. A bookmark records each boundary as a path from
// the nearest element with an `id` (or <body>): every step names its node, and a
// step into an element that carries a data identity attribute is matched by that
// identity rather than by position, so rows inserted or reordered above it do not
// lose it. The selected text travels with the bookmark: a restore applies only
// when the resolved range spells the same text, and otherwise drops it.
//
// Never a render gate. Capture and restore run around a rebuild that happens
// anyway, so a selection held for minutes cannot freeze anything. Restoring calls
// only the Selection API: no focus() and no scrolling.

const IDENTITY_ATTRIBUTES = [
  'data-card-id', 'data-row-id', 'data-context-key', 'data-note-item', 'data-project', 'data-tab',
  'data-relay-lane', 'data-dashboard-signal', 'data-dashboard-focus-key', 'data-rail-card',
]
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

let lastRestored = null

function identityKey(node) {
  if (node.nodeType !== 1) return null
  for (const attribute of IDENTITY_ATTRIBUTES) {
    const value = node.getAttribute(attribute)
    if (value !== null) return `${attribute}=${value}`
  }
  return null
}

function keyedSiblings(parent, key, name) {
  return Array.from(parent.children).filter((child) => child.nodeName === name && identityKey(child) === key)
}

function elementOf(node) {
  return node.nodeType === 1 ? node : node.parentElement
}

// A focused text field owns the caret: capture never runs while one is focused,
// so a field focused at restore time was focused by the repaint, and re-applying
// an old highlight would take its caret (Chromium moves the selection into a
// field on focus).
function textEntryFocused(documentRef) {
  const active = documentRef.activeElement
  return !!active && (typeof active.selectionStart === 'number' || active.isContentEditable === true)
}

// Text in a reply box or other field belongs to its editor: drafts and their
// focus restoration own it, and copy-on-select must never overwrite the
// clipboard with text the human selected only to replace.
function editingText(documentRef, node) {
  return !!elementOf(node)?.closest(EDITABLE_SELECTOR) || textEntryFocused(documentRef)
}

function locate(documentRef, node, offset) {
  const body = documentRef.body
  if (!body?.contains(node)) return null
  const steps = []
  let current = node
  while (current !== body && !(current.nodeType === 1 && current.id)) {
    const parent = current.parentNode
    if (!parent) return null
    const key = identityKey(current)
    steps.unshift(key
      ? { name: current.nodeName, key, ordinal: keyedSiblings(parent, key, current.nodeName).indexOf(current) }
      : { name: current.nodeName, index: Array.prototype.indexOf.call(parent.childNodes, current) })
    current = parent
  }
  return { root: current === body ? null : current.id, steps, offset }
}

function resolve(documentRef, point) {
  let node = point.root === null ? documentRef.body : documentRef.getElementById(point.root)
  for (const step of point.steps) {
    if (!node) return null
    node = step.key
      ? keyedSiblings(node, step.key, step.name)[step.ordinal]
      : node.childNodes[step.index]
    if (node?.nodeName !== step.name) return null
  }
  if (!node) return null
  const length = node.nodeType === 1 ? node.childNodes.length : node.length
  return point.offset <= length ? { node, offset: point.offset } : null
}

function textBetween(documentRef, anchor, focus) {
  const range = documentRef.createRange()
  range.setStart(anchor.node, anchor.offset)
  range.setEnd(focus.node, focus.offset)
  if (range.collapsed) {
    range.setStart(focus.node, focus.offset)
    range.setEnd(anchor.node, anchor.offset)
  }
  return range.toString()
}

function samePoint(left, right) {
  return left.root === right.root && left.offset === right.offset && left.steps.length === right.steps.length
    && left.steps.every((step, index) => {
      const other = right.steps[index]
      return step.name === other.name && step.key === other.key
        && (step.key ? step.ordinal === other.ordinal : step.index === other.index)
    })
}

// The current non-collapsed selection outside any editor, or null. `rangeText`
// is the DOM text a restore must find again; it never forces a layout.
export function captureSelection(documentRef = globalThis.document) {
  const selection = documentRef?.getSelection?.()
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection
  if (!anchorNode || !focusNode) return null
  if (editingText(documentRef, anchorNode) || editingText(documentRef, focusNode)) return null
  const rangeText = selection.getRangeAt(0).toString()
  if (rangeText === '') return null
  const anchor = locate(documentRef, anchorNode, anchorOffset)
  const focus = locate(documentRef, focusNode, focusOffset)
  if (!anchor || !focus) return null
  return {
    rangeText,
    anchor,
    focus,
    nodes: { anchorNode, anchorOffset, focusNode, focusOffset },
  }
}

// Put a captured selection back after a rebuild. An untouched selection is left
// alone; a resolvable one with the same text is reapplied in its direction; any
// other is dropped, so a rebuild never leaves a range stretched over new text.
export function restoreSelection(bookmark, documentRef = globalThis.document) {
  const selection = bookmark ? documentRef.getSelection?.() : null
  if (!selection || textEntryFocused(documentRef)) return
  const { anchorNode, anchorOffset, focusNode, focusOffset } = bookmark.nodes
  if (anchorNode.isConnected && focusNode.isConnected && selection.rangeCount === 1
    && selection.anchorNode === anchorNode && selection.anchorOffset === anchorOffset
    && selection.focusNode === focusNode && selection.focusOffset === focusOffset) return
  const anchor = resolve(documentRef, bookmark.anchor)
  const focus = resolve(documentRef, bookmark.focus)
  if (anchor && focus && textBetween(documentRef, anchor, focus) === bookmark.rangeText) {
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
    lastRestored = { anchorNode: anchor.node, anchorOffset: anchor.offset, focusNode: focus.node, focusOffset: focus.offset }
    return
  }
  if (selection.rangeCount > 0) selection.removeAllRanges()
}

// True while the selection is exactly the one restoreSelection() last applied,
// so the selectionchange it causes is not mistaken for the human selecting.
export function isRestoredSelection(documentRef = globalThis.document) {
  const selection = documentRef?.getSelection?.()
  return !!lastRestored && !!selection
    && selection.anchorNode === lastRestored.anchorNode && selection.anchorOffset === lastRestored.anchorOffset
    && selection.focusNode === lastRestored.focusNode && selection.focusOffset === lastRestored.focusOffset
}

// Whether two captures name the same selection, independent of the rebuild that
// may have replaced its nodes in between.
export function sameSelection(left, right) {
  if (!left || !right) return left === right
  return left.rangeText === right.rangeText && samePoint(left.anchor, right.anchor) && samePoint(left.focus, right.focus)
}
