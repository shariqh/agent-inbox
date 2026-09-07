import { KEYBOARD_COMMANDS } from './keys.js'
import { createKeyHints } from './key-hints.js'

const byId = new Map(KEYBOARD_COMMANDS.map((command) => [command.id, command]))
const editableSelector = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="color"]), textarea, select, [contenteditable]:not([contenteditable="false"])'

function editing(target) {
  return target instanceof Element && !!target.closest(editableSelector)
}

function available(element) {
  if (!element?.isConnected || element.closest('[hidden], [inert], [aria-disabled="true"]') || element.matches(':disabled')) return false
  if (['hidden', 'collapse'].includes(getComputedStyle(element).visibility)) return false
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    if (getComputedStyle(ancestor).display === 'none') return false
  }
  const closed = element.closest('details:not([open])')
  return !closed || !!closed.querySelector(':scope > summary')?.contains(element)
}

export function createKeyboardUI({ getScope, getActionScope, navigate }) {
  const root = document.getElementById('keyboardTools')
  const page = root.ownerDocument
  const view = page.defaultView
  const ElementType = view.Element
  const requestFrame = view.requestAnimationFrame.bind(view)
  const cancelFrame = view.cancelAnimationFrame.bind(view)
  const removeViewListener = view.removeEventListener.bind(view)
  const helpButton = document.getElementById('keyboardHelp')
  const hintsButton = document.getElementById('keyboardHints')
  const status = document.getElementById('keyboardStatus')
  const box = document.getElementById('keyboardbox')
  const panel = box.querySelector('.keyboard-panel')
  const closeButton = box.querySelector('.keyboard-close')
  const showKeysButton = document.getElementById('keyboardHintsFromHelp')
  const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '\u2318' : 'Ctrl'
  const format = (label) => label.replace(/\bMod\b/g, modifier)
  let goPrefix = false
  let returnFocus = null
  let frame = null
  let destroyed = false
  const decorated = new Map()

  function announce(message) {
    if (status.textContent !== message) status.textContent = message
  }

  function clearGo() {
    goPrefix = false
    root.removeAttribute('data-go-prefix')
    if (!hints.isActive()) announce('')
  }

  const hints = createKeyHints({
    getScope: () => root.isConnected ? getScope() : root,
    onChange(active) {
      hintsButton.setAttribute('aria-pressed', String(active))
      hintsButton.textContent = active ? 'Hide keys' : 'Show keys'
      if (!active) announce('')
    },
    onAnnounce: announce,
  })

  function rememberFocus() {
    const element = document.activeElement
    const owner = element?.closest?.('[data-card-id], [data-row-id]')
    return {
      element,
      scope: getScope(),
      id: element?.id,
      cardId: owner?.dataset.cardId,
      rowId: owner?.dataset.rowId,
      inCard: !!element?.closest?.('.nrow-card'),
    }
  }

  function restoreFocus() {
    const bookmark = returnFocus
    returnFocus = null
    let target = available(bookmark?.element) ? bookmark.element : null
    if (!target && bookmark?.id) target = document.getElementById(bookmark.id)
    if (!available(target) && (bookmark?.cardId || bookmark?.rowId)) {
      const attr = bookmark.cardId ? 'data-card-id' : 'data-row-id'
      const value = bookmark.cardId ?? bookmark.rowId
      const owner = document.querySelector(`[${attr}="${CSS.escape(value)}"]`)
      target = bookmark.inCard ? owner?.querySelector('.nrow-card') ?? owner : owner
      if (target && !target.matches('[tabindex], button, input, textarea, select, a[href], summary')) {
        target = target.querySelector('button, [tabindex]') ?? target
      }
    }
    if (!available(target) && bookmark?.scope instanceof HTMLElement && available(bookmark.scope)) {
      target = bookmark.scope
    }
    if (!available(target)) target = helpButton
    target?.focus({ preventScroll: true })
  }

  function closeHelp({ restore = true } = {}) {
    if (box.hidden) return
    box.hidden = true
    helpButton.setAttribute('aria-expanded', 'false')
    if (restore) restoreFocus()
  }

  function openHelp() {
    clearGo()
    hints.close()
    if (!box.hidden) return
    returnFocus = rememberFocus()
    box.hidden = false
    helpButton.setAttribute('aria-expanded', 'true')
    panel.focus({ preventScroll: true })
  }

  function toggleHints() {
    clearGo()
    closeHelp()
    hints.toggle()
  }

  function focusReply() {
    const scope = getActionScope()
    const editor = [...(scope?.querySelectorAll('textarea.reply-input:not(.reply-context-input):not([readonly])') ?? [])]
      .find(available)
    if (!editor) {
      announce('Open an item or plan step with a reply box first.')
      return
    }
    editor.focus({ preventScroll: true })
    editor.scrollIntoView({ block: 'nearest' })
  }

  function decorate(element, command, desired) {
    if (!element) return
    desired.set(element, command)
  }

  function refresh() {
    if (destroyed) return
    if (!root.isConnected) { destroy(); return }
    const desired = new Map()
    for (const command of KEYBOARD_COMMANDS) {
      if (command.selector) {
        for (const element of document.querySelectorAll(command.selector)) decorate(element, command, desired)
      }
    }
    const actionScope = getActionScope()
    for (const element of document.querySelectorAll('[data-shortcut-id]')) {
      const command = byId.get(element.dataset.shortcutId)
      if (command?.legacy && ['submit', 'resolve', 'dismiss', 'review'].includes(command.id)) {
        if (['resolve', 'dismiss'].includes(command.id) && !actionScope?.contains(element)) continue
        decorate(element, command, desired)
      }
    }
    if (actionScope) {
      const choices = [...actionScope.querySelectorAll('.opt-pill')].filter(available)
      choices.slice(0, 4).forEach((element, index) => {
        decorate(element, {
          id: `option-${index + 1}`, key: String(index + 1),
          display: String(index + 1), label: 'Choose this option',
        }, desired)
      })
      for (const editor of actionScope.querySelectorAll('textarea.reply-input:not(.reply-context-input)')) {
        if (available(editor)) decorate(editor.closest('.reply-row'), byId.get('reply'), desired)
      }
    }
    for (const [element, previous] of decorated) {
      if (desired.has(element)) continue
      if (element.getAttribute('data-shortcut') === previous.display) element.removeAttribute('data-shortcut')
      if (previous.originalId === null) element.removeAttribute('data-shortcut-id')
      else element.setAttribute('data-shortcut-id', previous.originalId)
      if (previous.originalAria === null) element.removeAttribute('aria-keyshortcuts')
      else element.setAttribute('aria-keyshortcuts', previous.originalAria)
      if (previous.originalDescription === null) element.removeAttribute('aria-description')
      else element.setAttribute('aria-description', previous.originalDescription)
      decorated.delete(element)
    }
    for (const [element, command] of desired) {
      const display = format(command.display)
      if (!decorated.has(element)) {
        decorated.set(element, {
          originalId: element.getAttribute('data-shortcut-id'),
          originalAria: element.getAttribute('aria-keyshortcuts'),
          originalDescription: element.getAttribute('aria-description'),
          display,
        })
      }
      decorated.get(element).display = display
      if (element.getAttribute('data-shortcut') !== display) element.setAttribute('data-shortcut', display)
      if (element.dataset.shortcutId !== command.id) element.dataset.shortcutId = command.id
      const shortcutDescription = command.prefix
        ? `Keyboard shortcut: ${command.prefix.toUpperCase()}, then ${command.key.toUpperCase()}.`
        : `Keyboard shortcut: ${display}.`
      const description = [decorated.get(element).originalDescription, shortcutDescription].filter(Boolean).join(' ')
      if (element.getAttribute('aria-description') !== description) element.setAttribute('aria-description', description)
      if (!command.prefix && element.matches('button, a[href]')) {
        const aria = command.key === 'mod+Enter' ? 'Control+Enter Meta+Enter'
          : command.key === '?' ? 'Shift+/' : command.key
        if (element.getAttribute('aria-keyshortcuts') !== aria) element.setAttribute('aria-keyshortcuts', aria)
      }
    }
    const searchKey = document.querySelector('.floating-search-key')
    const searchLabel = format('Mod K')
    if (searchKey && searchKey.textContent !== searchLabel) searchKey.textContent = searchLabel
    hints.refresh()
  }

  function scheduleRefresh() {
    if (destroyed || frame !== null) return
    frame = requestFrame(() => { frame = null; refresh() })
  }

  function consume(event) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function clickControl(event, control) {
    const scope = getScope()
    if (!available(control) || (scope !== document && !scope.contains(control))) return false
    consume(event)
    control.click()
    return true
  }

  function moveDialogFocus(event, scope) {
    const controls = [...scope.querySelectorAll(
      'button, input:not([type="hidden"]), textarea, select, a[href], summary, [tabindex], [contenteditable="true"]',
    )].filter((element) => available(element) && (!element.hasAttribute('tabindex') || element.tabIndex >= 0))
    const at = controls.indexOf(document.activeElement)
    const next = event.shiftKey ? (at <= 0 ? controls.length - 1 : at - 1)
      : (at < 0 || at === controls.length - 1 ? 0 : at + 1)
    consume(event)
    ;(controls[next] ?? scope).focus({ preventScroll: true })
  }

  function onKey(event) {
    if (destroyed || !root.isConnected || event.defaultPrevented) return
    if (event.isComposing || event.keyCode === 229) {
      clearGo()
      hints.close()
      return
    }
    const scope = getScope()
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && scope !== document) {
      hints.close()
      clearGo()
      moveDialogFocus(event, scope)
      return
    }
    if (!box.hidden) {
      if (event.key === 'Escape') { consume(event); closeHelp(); return }
      if (!event.repeat && event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        consume(event)
        toggleHints()
        return
      }
      event.stopImmediatePropagation()
      return
    }
    if (hints.isActive() && hints.handleKey(event)) { consume(event); return }
    if (editing(event.target)) { clearGo(); return }
    if (event.repeat) return
    const lower = event.key.toLowerCase()
    const modified = event.metaKey || event.ctrlKey || event.altKey
    const focusedControl = event.target instanceof Element
      ? event.target.closest('button[data-shortcut-id], a[data-shortcut-id]') : null
    const focusedCommand = focusedControl && byId.get(focusedControl.dataset.shortcutId)
    if (focusedCommand?.key === 'mod+Enter' && event.key === 'Enter'
      && (event.metaKey || event.ctrlKey) && !event.altKey) {
      if (clickControl(event, focusedControl)) return
    }
    if (modified) { clearGo(); return }
    if (goPrefix) {
      if (event.key === 'Tab') { clearGo(); return }
      consume(event)
      clearGo()
      if (event.key === 'Escape') return
      const command = KEYBOARD_COMMANDS.find((candidate) => candidate.prefix === 'g' && candidate.key === lower)
      if (command && getScope() === document) navigate(command.id)
      else announce('Shortcut cancelled. Press G to choose a destination, or F to show keys.')
      return
    }
    const command = KEYBOARD_COMMANDS.find((candidate) => !candidate.prefix && !candidate.legacy && candidate.key === lower)
    if (command) {
      consume(event)
      if (command.id === 'hints') toggleHints()
      else if (command.id === 'help') openHelp()
      else if (command.id === 'reply') focusReply()
      return
    }
    if (lower === 'g' && !event.shiftKey && getScope() === document) {
      consume(event)
      goPrefix = true
      root.setAttribute('data-go-prefix', 'true')
      announce('Go to: D Dashboard, I Inbox, P Plans, N Notes, H History, S Settings, O Projects, A Agents, L Live. Esc cancels.')
      return
    }
    if (/^[1-4]$/.test(lower)) {
      const choices = [...(getActionScope()?.querySelectorAll('.opt-pill') ?? [])].filter(available)
      const choice = choices[Number(lower) - 1]
      if (choice && clickControl(event, choice)) return
    }
    if (focusedControl) {
      const key = focusedControl.dataset.shortcutId?.startsWith('option-')
        ? focusedControl.dataset.shortcutId.slice('option-'.length)
        : !focusedCommand?.prefix ? focusedCommand?.key : null
      if (key && key === lower && clickControl(event, focusedControl)) return
    }
  }

  function onPointer(event) {
    if (destroyed || !root.isConnected) return
    clearGo()
    if (event.target instanceof Element && event.target.closest('#keyboardHints')) return
    hints.close()
  }

  function onFocus(event) {
    if (destroyed || !root.isConnected) return
    if (editing(event.target)) clearGo()
    scheduleRefresh()
  }

  function onPageHide(event) {
    if (!event.persisted) destroy()
  }

  function onBlur() {
    clearGo()
    hints.close()
  }

  const observer = new MutationObserver((mutations) => {
    if (!root.isConnected) { destroy(); return }
    const changed = mutations.some((mutation) => {
      if (mutation.target instanceof ElementType && mutation.target.closest('.key-hints-layer')) return false
      const nodes = [...mutation.addedNodes, ...mutation.removedNodes]
      return !nodes.length || !nodes.every((node) => node instanceof ElementType && node.matches('.key-hints-layer'))
    })
    if (changed) scheduleRefresh()
  })
  observer.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['hidden', 'open', 'disabled', 'aria-selected', 'data-shortcut-id'],
  })
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onPointer, true)
  document.addEventListener('focusin', onFocus)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('blur', onBlur)
  hintsButton.addEventListener('click', toggleHints)
  helpButton.addEventListener('click', openHelp)
  closeButton.addEventListener('click', closeHelp)
  box.querySelector('.keyboard-backdrop').addEventListener('click', closeHelp)
  showKeysButton.addEventListener('click', toggleHints)

  const groups = box.querySelector('.keyboard-groups')
  for (const group of new Set(KEYBOARD_COMMANDS.map((command) => command.group))) {
    const section = document.createElement('section')
    const heading = document.createElement('h3')
    heading.textContent = group
    const list = document.createElement('dl')
    for (const command of KEYBOARD_COMMANDS.filter((candidate) => candidate.group === group)) {
      const entry = document.createElement('div')
      const term = document.createElement('dt')
      const cap = document.createElement('kbd')
      cap.textContent = format(command.display)
      term.appendChild(cap)
      const meaning = document.createElement('dd')
      meaning.textContent = command.label
      entry.append(term, meaning)
      list.appendChild(entry)
    }
    section.append(heading, list)
    groups.appendChild(section)
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    if (frame !== null) cancelFrame(frame)
    observer.disconnect()
    hints.destroy()
    page.removeEventListener('keydown', onKey, true)
    page.removeEventListener('pointerdown', onPointer, true)
    page.removeEventListener('focusin', onFocus)
    removeViewListener('pagehide', onPageHide)
    removeViewListener('blur', onBlur)
    hintsButton.removeEventListener('click', toggleHints)
    helpButton.removeEventListener('click', openHelp)
    closeButton.removeEventListener('click', closeHelp)
    box.querySelector('.keyboard-backdrop').removeEventListener('click', closeHelp)
    showKeysButton.removeEventListener('click', toggleHints)
  }

  refresh()
  return { refresh, destroy }
}
