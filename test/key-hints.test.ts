// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKeyHints } from '../public/key-hints.js'

type Engine = ReturnType<typeof createKeyHints>
type Options = NonNullable<Parameters<typeof createKeyHints>[0]>

let engines: Engine[]
let boxes: Map<Element, DOMRect>
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let resizeObservers: { observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; notify(): void }[]

function rect(x = 0, y = 0, width = 48, height = 24) {
  return new DOMRect(x, y, width, height)
}

function element<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (!found) throw new Error(`Missing fixture: ${selector}`)
  return found
}

function paint(target: Element, x: number, y: number, width = 48, height = 24) {
  boxes.set(target, rect(x, y, width, height))
}

function layout() {
  const targets = document.querySelectorAll('button, a[href], input, select, textarea, summary, [role], [tabindex], [contenteditable]')
  targets.forEach((target, index) => paint(target, 10 + (index % 30) * 32, 10 + Math.floor(index / 30) * 30, 28, 24))
}

function mount(html: string) {
  document.body.innerHTML = html
  layout()
}

function start(options: Options = {}) {
  const engine = createKeyHints(options)
  engines.push(engine)
  engine.toggle()
  return engine
}

function badges() {
  return [...document.querySelectorAll<HTMLElement>('.key-hints-layer .key-hint')]
}

function codes() {
  return badges().map((badge) => badge.dataset.code!)
}

function key(engine: Engine, value: string, init: KeyboardEventInit = {}, target?: Element) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init })
  if (target) Object.defineProperty(event, 'target', { value: target })
  const handled = engine.handleKey(event)
  // The parent owns dispatch and stops the app's ordinary shortcuts on true.
  if (handled) event.preventDefault()
  return { handled, event }
}

function type(engine: Engine, code: string) {
  return [...code].map((letter) => key(engine, letter))
}

async function frame() {
  await Promise.resolve()
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => callback(0))
  await Promise.resolve()
}

beforeEach(() => {
  engines = []
  boxes = new Map()
  frames = new Map()
  nextFrame = 0
  resizeObservers = []
  document.body.innerHTML = ''
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id) }))
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
    constructor(private callback: ResizeObserverCallback) { resizeObservers.push(this) }
    notify() { this.callback([], this as unknown as ResizeObserver) }
  })
  vi.stubGlobal('innerWidth', 1000)
  vi.stubGlobal('innerHeight', 800)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('.key-hint')) return rect(0, 0, 28, 20)
    return boxes.get(this) ?? rect(0, 0, 1000, 800)
  })
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    const box = boxes.get(this)
    return (box && this.isConnected ? [box] : []) as unknown as DOMRectList
  })
  // jsdom supplies no layout or hit testing. These fixtures explicitly model
  // geometry; real CSS clipping/media queries belong to the parent's browser pass.
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn((x: number, y: number) => {
      const hits = [...boxes.entries()].filter(([node, box]) =>
        node.isConnected && x >= box.left && x < box.right && y >= box.top && y < box.bottom,
      )
      return hits.reverse().find(([node]) =>
        !hits.some(([other]) => other !== node && node.contains(other)),
      )?.[0] ?? document.body
    }),
  })
})

afterEach(() => {
  engines.forEach((engine) => engine.destroy())
  document.body.innerHTML = ''
  delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('key-hint layer', () => {
  it('has no independent entry hotkey and exposes only inert, hidden-from-AT tiles', () => {
    mount('<button id="one">Open</button>')
    const onChange = vi.fn()
    const onAnnounce = vi.fn()
    const engine = createKeyHints({ onChange, onAnnounce })
    engines.push(engine)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }))
    engine.refresh()
    expect(engine.isActive()).toBe(false)
    expect(badges()).toHaveLength(0)
    engine.toggle()
    const layer = element('.key-hints-layer')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.style.pointerEvents).toBe('none')
    expect(layer.querySelector('button, a, input, [tabindex]')).toBeNull()
    expect(codes()).toEqual(['AA'])
    expect(badges()[0]!.textContent).toBe('AA')
    expect(onChange).toHaveBeenLastCalledWith(true)
    expect(onAnnounce).toHaveBeenCalledWith(expect.stringMatching(/code|letter/i))
    engine.toggle()
    expect(engine.isActive()).toBe(false)
    expect(document.querySelector('.key-hints-layer')).toBeNull()
    expect(onChange.mock.calls).toEqual([[true], [false]])
  })

  it('assigns deterministic, unique fixed two-letter codes, including beyond one alphabet', () => {
    mount(Array.from({ length: 80 }, (_, i) => `<button id="control-${i}">${i}</button>`).join(''))
    const engine = start()
    const first = codes()
    expect(first).toHaveLength(80)
    expect(new Set(first).size).toBe(80)
    expect(first.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true)
    expect(first.every((code) => first.every((other) => code === other || !other.startsWith(code)))).toBe(true)
    engine.close()
    engine.toggle()
    expect(codes()).toEqual(first)
  })

  it('clamps tiles to the viewport even when only an edge of a target is visible', () => {
    mount('<button id="top">Top</button><button id="bottom">Bottom</button>')
    paint(element('#top'), -8, -4, 48, 24)
    paint(element('#bottom'), 995, 797, 48, 24)
    start()
    expect(badges()).toHaveLength(2)
    for (const badge of badges()) {
      expect(parseFloat(badge.style.left)).toBeGreaterThanOrEqual(0)
      expect(parseFloat(badge.style.top)).toBeGreaterThanOrEqual(0)
      expect(parseFloat(badge.style.left) + 28).toBeLessThanOrEqual(1000)
      expect(parseFloat(badge.style.top) + 20).toBeLessThanOrEqual(800)
    }
  })

  it('keeps an empty mode safe instead of leaking the next destructive shortcut', () => {
    mount('<div tabindex="-1">Noninteractive container</div>')
    const onAnnounce = vi.fn()
    const engine = start({ onAnnounce })
    expect(badges()).toHaveLength(0)
    expect(engine.isActive()).toBe(true)
    expect(key(engine, 'x').handled).toBe(true)
    expect(onAnnounce).toHaveBeenCalledWith(expect.stringMatching(/no|0/i))
  })
})

describe('activation and native focus', () => {
  it('focuses and closes the layer before following the existing click path', () => {
    mount('<button id="one">Dismiss</button>')
    const target = element('#one')
    const click = vi.fn(() => {
      expect(document.activeElement).toBe(target)
      expect(engine.isActive()).toBe(false)
    })
    target.addEventListener('click', click)
    const engine = start()
    expect(type(engine, codes()[0]!.toLowerCase()).every((result) => result.handled)).toBe(true)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it.each([
    '<input id="target" aria-label="Reply">',
    '<input id="target" type="range" aria-label="Range">',
    '<input id="target" type="date" aria-label="Date">',
    '<input id="target" type="color" aria-label="Color">',
    '<select id="target" aria-label="Project"><option>All</option></select>',
    '<textarea id="target" aria-label="Reply"></textarea>',
    '<div id="target" contenteditable="true">Draft</div>',
    '<div id="target" role="separator" tabindex="0" aria-label="Resize pane"></div>',
    '<time id="target" tabindex="0">Today</time>',
  ])('focuses, without clicking, native interaction target %s', (html) => {
    mount(html)
    const target = element('#target')
    const click = vi.fn()
    target.addEventListener('click', click)
    const engine = start()
    expect(codes()).toHaveLength(1)
    type(engine, codes()[0]!)
    expect(document.activeElement).toBe(target)
    expect(click).not.toHaveBeenCalled()
    expect(engine.isActive()).toBe(false)
  })

  it.each([
    '<button id="target">Action</button>',
    '<a id="target" href="#destination">Destination</a>',
    '<input id="target" type="checkbox" aria-label="Include">',
    '<input id="target" type="radio" aria-label="Choose">',
    '<details><summary id="target">Background</summary><p>Text</p></details>',
    '<div id="target" role="button" tabindex="0">Action</div>',
    '<div id="target" role="tab" tabindex="-1">Plans</div>',
    '<div id="target" role="option" tabindex="-1">Item</div>',
    '<svg><g id="target" role="button" tabindex="0" aria-label="Plan step"><rect width="20" height="20"/></g></svg>',
  ])('uses the existing click path for %s', (html) => {
    mount(html)
    const target = element('#target')
    const click = vi.fn((event: Event) => {
      if (target.localName === 'a') event.preventDefault()
    })
    target.addEventListener('click', click)
    const engine = start()
    expect(codes()).toHaveLength(1)
    type(engine, codes()[0]!)
    expect(click).toHaveBeenCalledTimes(1)
    if (target instanceof HTMLInputElement) expect(target.checked).toBe(true)
    if (target.localName === 'summary') expect(target.parentElement!.hasAttribute('open')).toBe(true)
  })
})

describe('operable targets only', () => {
  it('filters hidden, disabled, inert, opt-out and engine-owned controls, but not roving controls', () => {
    mount(`
      <button id="visible">Visible</button>
      <button hidden>Hidden</button>
      <button disabled>Disabled</button>
      <div aria-disabled="true"><button>Unavailable</button></div>
      <fieldset disabled><button>Fieldset disabled</button></fieldset>
      <div inert><button>Inert</button></div>
      <div aria-hidden="true"><button>AT hidden</button></div>
      <div style="display:none"><button>Not displayed</button></div>
      <div style="opacity:0"><button>Transparent</button></div>
      <button style="visibility:hidden">Invisible</button>
      <button style="pointer-events:none">No pointer action</button>
      <input type="hidden" tabindex="0">
      <div data-key-hints-ignore><button>Opt out</button></div>
      <button data-key-hints-ignore>Toggle</button>
      <div class="key-hints-layer"><button>Overlay</button></div>
      <section tabindex="-1">Container</section>
      <button id="roving" tabindex="-1">Roving button</button>
    `)
    start()
    expect(badges()).toHaveLength(2)
  })

  it('allows the first summary but not closed-details descendants or nested closed summaries', () => {
    mount(`
      <details id="closed">
        <summary id="shown">Shown</summary>
        <button>Hidden action</button>
        <details><summary>Hidden nested summary</summary></details>
      </details>
      <details open><summary id="open-summary">Open summary</summary><button id="inside">Visible action</button></details>
    `)
    start()
    expect(badges()).toHaveLength(3)
  })

  it('excludes viewport and scroll-clipped targets, including partial clipping on one axis', () => {
    mount('<div id="scroll" style="overflow-x:auto;overflow-y:auto"><button id="partial">Partial</button><button id="clipped">Clipped</button></div><button id="offscreen">Offscreen</button>')
    paint(element('#scroll'), 0, 0, 100, 100)
    paint(element('#partial'), 90, 20, 30, 24)
    paint(element('#clipped'), 130, 30)
    paint(element('#offscreen'), 1100, 20)
    start()
    expect(badges()).toHaveLength(1)
  })

  it('keeps viewport-fixed controls and their children despite an unrelated overflow ancestor', () => {
    mount(`
      <div id="clip" style="overflow-x:hidden;overflow-y:hidden">
        <button id="fixed" style="position:fixed">Fixed</button>
        <div style="position:fixed"><button id="fixed-child">Fixed child</button></div>
      </div>
    `)
    paint(element('#clip'), 0, 0, 100, 100)
    paint(element('#fixed'), 400, 20)
    paint(element('#fixed-child'), 500, 20)
    start()
    expect(badges()).toHaveLength(2)
  })

  it('respects overflow when a transform really contains a fixed target', () => {
    mount('<div id="clip" style="overflow-x:hidden;overflow-y:hidden;transform:translateX(0)"><button id="fixed" style="position:fixed">Fixed</button></div>')
    paint(element('#clip'), 0, 0, 100, 100)
    paint(element('#fixed'), 400, 20)
    start()
    expect(badges()).toHaveLength(0)
  })

  it('rejects occluded controls while accepting a hit on their noninteractive icon', () => {
    mount('<button id="covered">Covered</button><div id="cover"></div><button id="icon-button"><span id="icon">Icon</span></button>')
    paint(element('#covered'), 10, 10)
    paint(element('#cover'), 10, 10)
    paint(element('#icon-button'), 100, 10)
    paint(element('#icon'), 100, 10)
    start()
    expect(badges()).toHaveLength(1)
  })
})

describe('keyboard ownership', () => {
  it('edits prefixes, keeps full codes visible, and consumes Escape without dispatching an action', () => {
    mount(Array.from({ length: 28 }, (_, i) => `<button id="button-${i}">${i}</button>`).join(''))
    const engine = start()
    const original = codes()
    expect(key(engine, 'b').handled).toBe(true)
    expect(codes()).toEqual(original)
    expect(badges().filter((badge) => badge.classList.contains('is-match'))).toHaveLength(2)
    expect(badges().filter((badge) => badge.classList.contains('is-dim'))).toHaveLength(26)
    expect(key(engine, 'Backspace').handled).toBe(true)
    expect(badges().some((badge) => badge.classList.contains('is-dim'))).toBe(false)
    expect(key(engine, 'Escape').handled).toBe(true)
    expect(engine.isActive()).toBe(false)
  })

  it('consumes invalid/destructive keys, announces refusal, and never falls through', () => {
    mount('<button id="one">Dismiss</button>')
    const onAnnounce = vi.fn()
    const click = vi.fn()
    element('#one').addEventListener('click', click)
    const engine = start({ onAnnounce })
    for (const value of ['x', 'e', '1', '2', '3', '4', '?', 'Delete']) {
      expect(key(engine, value).handled).toBe(true)
    }
    expect(click).not.toHaveBeenCalled()
    expect(engine.isActive()).toBe(true)
    expect(onAnnounce).toHaveBeenLastCalledWith(expect.stringMatching(/code|letter|match/i))
  })

  it('never completes a code from repeat or composition, including legacy IME events', () => {
    mount('<button id="one">Dismiss</button>')
    const click = vi.fn()
    element('#one').addEventListener('click', click)
    const engine = start()
    key(engine, 'a')
    expect(key(engine, 'a', { repeat: true }).handled).toBe(true)
    expect(click).not.toHaveBeenCalled()
    expect(key(engine, 'a', { isComposing: true }).handled).toBe(true)
    expect(key(engine, 'x', { keyCode: 229 }).handled).toBe(true)
    expect(click).not.toHaveBeenCalled()
    key(engine, 'a')
    expect(click).not.toHaveBeenCalled()
    key(engine, 'a')
    expect(click).toHaveBeenCalledTimes(1)
  })

  it.each([
    '<input id="editor">',
    '<input id="editor" type="range">',
    '<select id="editor"><option>All</option></select>',
    '<textarea id="editor"></textarea>',
    '<div id="editor" contenteditable="true"><span>Text</span></div>',
  ])('never takes typing or native selection from %s', (html) => {
    mount(`<button id="action">Action</button>${html}`)
    const editor = element('#editor')
    const engine = start()
    editor.focus()
    for (const value of ['a', 'Backspace', 'ArrowDown', ' ']) {
      const result = key(engine, value, { isComposing: value === 'a' }, editor)
      expect(result.handled).toBe(false)
      expect(result.event.defaultPrevented).toBe(false)
    }
    expect(engine.isActive()).toBe(false)
  })

  it.each(['Tab', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' '])('passes through native %s and exits', (value) => {
    mount('<button id="one">Action</button>')
    const engine = start()
    expect(key(engine, value).handled).toBe(false)
    expect(engine.isActive()).toBe(false)
  })

  it('passes modified shortcuts through, but permits shifted letters', () => {
    mount('<button id="one">Action</button>')
    const click = vi.fn()
    element('#one').addEventListener('click', click)
    const engine = start()
    expect(key(engine, 'k', { metaKey: true }).handled).toBe(false)
    expect(engine.isActive()).toBe(false)
    engine.toggle()
    key(engine, 'Shift', { shiftKey: true })
    key(engine, 'A', { shiftKey: true })
    key(engine, 'A', { shiftKey: true })
    expect(click).toHaveBeenCalledTimes(1)
  })
})

describe('polling and activation-time validation', () => {
  it('refuses a disconnected target before the mutation observer has delivered', () => {
    mount('<button id="one">Dismiss</button>')
    const target = element('#one')
    const click = vi.fn()
    const onAnnounce = vi.fn()
    target.addEventListener('click', click)
    const engine = start({ onAnnounce })
    const original = codes()[0]!
    target.remove()
    expect(type(engine, original).every((result) => result.handled)).toBe(true)
    expect(click).not.toHaveBeenCalled()
    expect(onAnnounce).toHaveBeenLastCalledWith(expect.stringMatching(/changed|available|stale/i))
  })

  it.each(['label', 'href', 'version', 'ancestor-revision', 'owner', 'disabled', 'occluded'])('refuses a changed %s without waiting for observers', (change) => {
    mount('<div data-card-id="item-1" data-row-revision="1"><a id="target" href="#one" data-key-hint-owner="item:item-1" data-key-hint-version="1">Dismiss</a></div>')
    const target = element('#target')
    const click = vi.fn((event: Event) => event.preventDefault())
    const onAnnounce = vi.fn()
    target.addEventListener('click', click)
    const engine = start({ onAnnounce })
    const original = codes()[0]!
    key(engine, original[0]!)
    if (change === 'label') target.textContent = 'Resolve'
    if (change === 'href') target.setAttribute('href', '#two')
    if (change === 'version') target.dataset.keyHintVersion = '2'
    if (change === 'ancestor-revision') target.parentElement!.dataset.rowRevision = '2'
    if (change === 'owner') target.parentElement!.dataset.cardId = 'item-2'
    if (change === 'disabled') target.setAttribute('aria-disabled', 'true')
    if (change === 'occluded') vi.mocked(document.elementFromPoint).mockReturnValue(document.body)
    expect(key(engine, original[1]!).handled).toBe(true)
    expect(click).not.toHaveBeenCalled()
    expect(onAnnounce).toHaveBeenLastCalledWith(expect.stringMatching(/changed|available|stale/i))
    expect(codes()).not.toContain(original)
  })

  it('preserves codes and an entered prefix across unique equivalent replacements and reordering', async () => {
    const item = (id: string) => `<article data-card-id="${id}"><button data-key-hint-owner="item:${id}" data-key-hint-version="7">Dismiss</button></article>`
    mount(`<main id="queue">${item('one')}${item('two')}</main>`)
    const onChange = vi.fn()
    const engine = start({ onChange })
    const original = codes()[0]!
    key(engine, original[0]!)
    element('#queue').innerHTML = item('two') + item('one')
    layout()
    const one = element('[data-card-id="one"] button')
    const two = element('[data-card-id="two"] button')
    const clickOne = vi.fn()
    const clickTwo = vi.fn()
    one.addEventListener('click', clickOne)
    two.addEventListener('click', clickTwo)
    await frame()
    expect(engine.isActive()).toBe(true)
    expect(new Set(codes())).toEqual(new Set(['AA', 'AB']))
    expect(onChange.mock.calls).toEqual([[true]])
    expect(key(engine, original[1]!).handled).toBe(true)
    expect(clickOne).toHaveBeenCalledTimes(1)
    expect(clickTwo).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(one)
  })

  it('preserves a phone-card scope and partial code across an unchanged replacement', async () => {
    mount('<article data-key-hint-owner="row:one" data-key-hint-version="7:3"><div class="nrow-card" tabindex="-1"><button>Send</button></div></article>')
    const engine = start({ getScope: () => element<HTMLElement>('.nrow-card') })
    const original = codes()[0]!
    key(engine, original[0]!)
    const previous = element('.nrow-card')
    const replacement = previous.cloneNode(true) as HTMLElement
    previous.replaceWith(replacement)
    layout()
    const click = vi.fn()
    replacement.querySelector('button')!.addEventListener('click', click)
    await frame()
    expect(codes()).toEqual([original])
    key(engine, original[1]!)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it.each(['owner', 'version', 'view'])('retires phone-card codes when the replacement changes its %s', (change) => {
    mount('<article data-key-hint-owner="row:one" data-key-hint-version="7:3"><div class="nrow-card" tabindex="-1"><button>Send</button></div></article>')
    let scope = element('.nrow-card')
    const engine = start({ getScope: () => scope })
    const original = codes()[0]!
    key(engine, original[0]!)
    const replacement = scope.cloneNode(true) as HTMLElement
    scope.replaceWith(replacement)
    scope = replacement
    if (change === 'owner') element('article').dataset.keyHintOwner = 'row:two'
    if (change === 'version') element('article').dataset.keyHintVersion = '7:4'
    if (change === 'view') replacement.className = 'different-view'
    layout()
    const click = vi.fn()
    replacement.querySelector('button')!.addEventListener('click', click)
    key(engine, original[1]!)
    expect(codes()).not.toContain(original)
    expect(click).not.toHaveBeenCalled()
  })

  it('preserves the nearest semantic owner/version across equivalent replacements without generic row IDs', () => {
    const content = '<section data-key-hint-owner="item:outer" data-key-hint-version="2026-09-06T23:00:00Z"><div data-key-hint-owner="row:inner" data-key-hint-version="9:4"><button>Send</button></div></section>'
    mount(`<main>${content}</main>`)
    const engine = start()
    const original = codes()[0]!
    key(engine, original[0]!)
    element('main').innerHTML = content
    layout()
    engine.refresh()
    expect(codes()).toEqual([original])
    const click = vi.fn()
    element('button').addEventListener('click', click)
    key(engine, original[1]!)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it.each(['owner', 'row-revision', 'board-revision'])('invalidates the nearest semantic %s while labels and outer identity stay unchanged', (change) => {
    mount('<section data-card-id="outer" data-key-hint-owner="item:outer" data-key-hint-version="2026-09-06T23:00:00Z"><div data-key-hint-owner="row:inner" data-key-hint-version="9:4"><button>Send</button></div></section>')
    const engine = start()
    const original = codes()[0]!
    const click = vi.fn()
    element('button').addEventListener('click', click)
    key(engine, original[0]!)
    const owner = element('[data-key-hint-owner="row:inner"]')
    if (change === 'owner') owner.dataset.keyHintOwner = 'row:another'
    else owner.dataset.keyHintVersion = change === 'row-revision' ? '9:5' : '10:4'
    expect(key(engine, original[1]!).handled).toBe(true)
    expect(click).not.toHaveBeenCalled()
    expect(codes()).not.toContain(original)
    expect(element('button').textContent).toBe('Send')
  })

  it('ignores persistent keycap decoration while retaining action/version fingerprints', () => {
    mount('<button id="one">Dismiss</button>')
    const engine = start()
    const original = codes()[0]!
    const target = element('#one')
    target.dataset.shortcut = 'X'
    target.dataset.shortcutId = 'dismiss'
    target.dataset.keyboardKeys = 'X'
    target.dataset.keyboardId = 'dismiss'
    target.setAttribute('aria-keyshortcuts', 'x')
    target.setAttribute('aria-description', 'Keyboard shortcut: X.')
    engine.refresh()
    expect(codes()).toEqual([original])
  })

  it.each(['data-card-id', 'data-row-id'])('keeps %s identity when a rerender is measured before keycap decoration', (owner) => {
    const content = `<article class="nrow" ${owner}="entity-1" data-row-revision="7"><button data-key-hint-version="7">Dismiss</button></article>`
    mount(`<main id="queue">${content}</main>`)
    const decorate = () => {
      const target = element('button')
      target.dataset.shortcut = 'X'
      target.dataset.shortcutId = 'dismiss'
      target.dataset.keyboardId = 'dismiss'
      target.setAttribute('aria-keyshortcuts', 'x')
      target.setAttribute('aria-description', 'Keyboard shortcut: X.')
      target.parentElement!.dataset.keyboardOwner = 'shortcut-group'
      target.parentElement!.dataset.keyboardVersion = '1'
    }
    decorate()
    const engine = start()
    const original = codes()[0]!
    key(engine, original[0]!)
    element('#queue').innerHTML = content
    layout()
    engine.refresh()
    expect(codes()).toEqual([original])
    decorate()
    engine.refresh()
    expect(codes()).toEqual([original])
    const click = vi.fn()
    element('button').addEventListener('click', click)
    key(engine, original[1]!)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('never treats presentation-only keyboard metadata as an anonymous control identity', () => {
    mount('<section data-keyboard-owner="shortcuts"><button data-keyboard-id="dismiss">Dismiss</button></section>')
    const engine = start()
    const original = codes()[0]!
    element('section').innerHTML = '<button data-keyboard-id="dismiss">Dismiss</button>'
    layout()
    engine.refresh()
    expect(codes()).not.toContain(original)
    const click = vi.fn()
    element('button').addEventListener('click', click)
    type(engine, original)
    expect(click).not.toHaveBeenCalled()
  })

  it('does not identify anonymous replacement controls by position or label alone', () => {
    mount('<section><button>Dismiss</button></section>')
    const engine = start()
    const original = codes()[0]!
    element('section').innerHTML = '<button>Dismiss</button>'
    layout()
    const click = vi.fn()
    element('button').addEventListener('click', click)
    engine.refresh()
    expect(codes()).not.toContain(original)
    type(engine, original)
    expect(click).not.toHaveBeenCalled()
  })

  it('never rebinds an ambiguous semantic identity to the other matching node', () => {
    mount('<article data-card-id="one"><button>Dismiss</button><button>Dismiss</button></article>')
    const engine = start()
    const original = codes()[0]!
    expect(new Set(codes()).size).toBe(2)
    element('button').remove()
    engine.refresh()
    const click = vi.fn()
    element('button').addEventListener('click', click)
    type(engine, original)
    expect(click).not.toHaveBeenCalled()
  })

  it('remembers ambiguity introduced while the original node still exists', () => {
    mount('<article data-card-id="one"><button>Dismiss</button></article>')
    const engine = start()
    const original = codes()[0]!
    const first = element('button')
    first.insertAdjacentHTML('afterend', '<button>Dismiss</button>')
    layout()
    engine.refresh()
    first.remove()
    engine.refresh()
    const click = vi.fn()
    element('button').addEventListener('click', click)
    type(engine, original)
    expect(click).not.toHaveBeenCalled()
    expect(codes()).not.toContain(original)
  })

  it('reserves removed codes and assigns additions new codes without renumbering surviving controls', () => {
    mount('<main><button id="one">One</button><button id="two">Two</button></main>')
    const engine = start()
    element('#one').remove()
    element('main').insertAdjacentHTML('afterbegin', '<button id="three">Three</button>')
    layout()
    engine.refresh()
    expect(new Set(codes())).toEqual(new Set(['AB', 'AC']))
    const click = vi.fn()
    element('#three').addEventListener('click', click)
    type(engine, 'AA')
    expect(click).not.toHaveBeenCalled()
  })

  it('enumerates only the supplied modal scope and consumes a code when the scope changes', () => {
    mount('<button id="outside">Outside</button><section id="modal" role="dialog"><button id="inside">Inside</button></section>')
    let scope: Document | HTMLElement = element<HTMLElement>('#modal')
    const click = vi.fn()
    element('#outside').addEventListener('click', click)
    element('#inside').addEventListener('click', click)
    const onAnnounce = vi.fn()
    const engine = start({ getScope: () => scope, onAnnounce })
    expect(codes()).toHaveLength(1)
    key(engine, 'a')
    scope = document
    expect(key(engine, 'a').handled).toBe(true)
    expect(click).not.toHaveBeenCalled()
    expect(engine.isActive()).toBe(true)
    expect(codes()).not.toContain('AA')
    expect(onAnnounce).toHaveBeenLastCalledWith(expect.stringMatching(/changed|available/i))
  })

  it('keeps guarding an unfinished code when an observer notices a modal change first', async () => {
    mount('<button id="outside">Outside</button><section id="modal" role="dialog" hidden><button id="inside">Inside</button></section>')
    let scope: Document | HTMLElement = document
    const engine = start({ getScope: () => scope })
    key(engine, 'a')
    const modal = element<HTMLElement>('#modal')
    modal.hidden = false
    scope = modal
    await frame()
    expect(engine.isActive()).toBe(true)
    expect(codes()).toEqual(['AB'])
    const click = vi.fn()
    element('#inside').addEventListener('click', click)
    expect(key(engine, 'a').handled).toBe(true)
    expect(click).not.toHaveBeenCalled()
    expect(key(engine, 'x').handled).toBe(true)
  })

  it('revalidates after focus handlers before sending a click', () => {
    mount('<button id="one" data-key-hint-version="1">Dismiss</button>')
    const target = element('#one')
    target.addEventListener('focus', () => { target.dataset.keyHintVersion = '2' })
    const click = vi.fn()
    const onAnnounce = vi.fn()
    target.addEventListener('click', click)
    const engine = start({ onAnnounce })
    type(engine, codes()[0]!)
    expect(click).not.toHaveBeenCalled()
    expect(onAnnounce).toHaveBeenLastCalledWith(expect.stringMatching(/changed|available|stale/i))
  })
})

describe('capacity and lifecycle', () => {
  it('uses fixed three-letter codes if the opening view exceeds two-letter capacity', () => {
    mount(Array.from({ length: 677 }, (_, i) => `<button id="b-${i}">${i}</button>`).join(''))
    const engine = start()
    expect(codes()).toHaveLength(677)
    expect(new Set(codes()).size).toBe(677)
    expect(codes().every((code) => /^[A-Z]{3}$/.test(code))).toBe(true)
    const click = vi.fn()
    element('#b-0').addEventListener('click', click)
    key(engine, 'a')
    key(engine, 'a')
    expect(click).not.toHaveBeenCalled()
    key(engine, 'a')
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('does not recycle tombstones or change code length when capacity is reached mid-mode', () => {
    mount(Array.from({ length: 676 }, (_, i) => `<button id="b-${i}">${i}</button>`).join(''))
    const onAnnounce = vi.fn()
    const engine = start({ onAnnounce })
    element('#b-0').remove()
    document.body.insertAdjacentHTML('afterbegin', '<button id="new">New action</button>')
    layout()
    engine.refresh()
    expect(codes()).toHaveLength(675)
    expect(codes()).not.toContain('AA')
    expect(codes().every((code) => code.length === 2)).toBe(true)
    expect(onAnnounce).toHaveBeenLastCalledWith(expect.stringMatching(/capacity|reopen/i))
    engine.close()
    engine.toggle()
    expect(codes()).toHaveLength(676)
  })

  it('coalesces layout changes, ignores its own mutations, and disconnects everything on destroy', async () => {
    mount('<button id="one">One</button>')
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const engine = start()
    await frame()
    await frame()
    expect(frames.size).toBe(0)
    key(engine, 'a')
    await frame()
    expect(frames.size).toBe(0)
    element('#one').textContent = 'Updated'
    await Promise.resolve()
    window.dispatchEvent(new Event('resize'))
    document.dispatchEvent(new Event('scroll'))
    resizeObservers.forEach((observer) => observer.notify())
    expect(frames.size).toBe(1)
    engine.destroy()
    expect(frames.size).toBe(0)
    expect(disconnect).toHaveBeenCalled()
    expect(resizeObservers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true)
    element('#one').textContent = 'Again'
    window.dispatchEvent(new Event('resize'))
    document.dispatchEvent(new Event('scroll'))
    await Promise.resolve()
    expect(frames.size).toBe(0)
    engine.toggle()
    engine.refresh()
    expect(engine.isActive()).toBe(false)
    expect(key(engine, 'a').handled).toBe(false)
    expect(document.querySelector('.key-hints-layer')).toBeNull()
  })

  it('does not open a document-wide layer when its supplied root is already disconnected', () => {
    mount('<button id="new-control">A different app boot</button>')
    const disconnected = document.createElement('main')
    const engine = start({ getScope: () => disconnected })
    expect(engine.isActive()).toBe(false)
    expect(badges()).toHaveLength(0)
    expect(resizeObservers).toHaveLength(0)
    engine.toggle()
    expect(badges()).toHaveLength(0)
  })

  it('destroys only its own layer when its active root disconnects before observer delivery', () => {
    mount('<main id="old-root"><button id="old-control">Old</button></main>')
    const root = element<HTMLElement>('#old-root')
    const onChange = vi.fn()
    const old = start({ getScope: () => root, onChange })
    const oldLayer = element('.key-hints-layer')
    root.remove()
    document.body.insertAdjacentHTML('afterbegin', '<button id="new-control">New</button>')
    layout()
    const current = start()
    const currentLayer = [...document.querySelectorAll('.key-hints-layer')].find((layer) => layer !== oldLayer)!
    expect(key(old, 'x').handled).toBe(true)
    expect(old.isActive()).toBe(false)
    expect(oldLayer.isConnected).toBe(false)
    expect(currentLayer.isConnected).toBe(true)
    expect(current.isActive()).toBe(true)
    expect(onChange.mock.calls).toEqual([[true], [false]])
    old.refresh()
    old.close()
    old.destroy()
    old.toggle()
    expect(document.querySelectorAll('.key-hints-layer')).toHaveLength(1)
  })

  it('cleans up a prior app boot without removing a newer overlay in the retained document', async () => {
    mount('<main id="old-root"><button id="old-control">Old</button></main>')
    const root = element<HTMLElement>('#old-root')
    const old = start({ getScope: () => root.isConnected ? document : root })
    const oldResizeObserver = resizeObservers[0]!
    key(old, 'a')
    mount('<main id="new-root"><button id="new-control">New</button></main>')
    const current = start()
    const currentLayer = element('.key-hints-layer')
    const bodyClass = document.body.className
    await frame()
    await frame()
    expect(old.isActive()).toBe(false)
    expect(oldResizeObserver.disconnect).toHaveBeenCalled()
    expect(current.isActive()).toBe(true)
    expect(document.querySelectorAll('.key-hints-layer')).toHaveLength(1)
    expect(currentLayer.isConnected).toBe(true)
    expect(document.body.className).toBe(bodyClass)
    expect(frames.size).toBe(0)
    window.dispatchEvent(new Event('resize'))
    expect(frames.size).toBe(1)
    old.destroy()
    old.refresh()
    old.toggle()
    expect(currentLayer.isConnected).toBe(true)
    current.destroy()
    expect(frames.size).toBe(0)
  })

  it('allows one live instance to close without clearing another instance or a shared body class', async () => {
    mount('<button id="one">One</button>')
    const bodyClass = document.body.className
    const old = start()
    const oldLayer = element('.key-hints-layer')
    const current = start()
    const currentLayer = [...document.querySelectorAll('.key-hints-layer')].find((layer) => layer !== oldLayer)!
    old.close()
    old.destroy()
    await frame()
    expect(oldLayer.isConnected).toBe(false)
    expect(currentLayer.isConnected).toBe(true)
    expect(current.isActive()).toBe(true)
    expect(document.querySelectorAll('.key-hints-layer')).toHaveLength(1)
    expect(document.body.className).toBe(bodyClass)
  })
})
