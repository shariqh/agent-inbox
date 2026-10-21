// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pagePath = resolve('marketing/index.html')

const THREE_MODULE = 'https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.module.js'
const THREE_CORE = 'https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.core.js'
// sha384 of the npm tarball's build files, which jsDelivr serves byte for byte.
const PINNED = {
  [THREE_MODULE]: 'sha384-m8JoFX52V6NGv2usipnlLJKnJfL7IE8dbniPDDCSGSQv3Hm4n6PjfV6syVwfuoRc',
  [THREE_CORE]: 'sha384-mdKeCwPEcbDvzaxwhm+MVuLoMou+E7jQqrs4tmu/n8HBYPGI1kZt0MkJxlMR4zFM',
}

function heroScript(): HTMLScriptElement {
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[type="module"]')
  expect(scripts).toHaveLength(1)
  return scripts[0]!
}

// jsdom has no HTMLScriptElement.supports, and its link relList rejects
// modulepreload. Leaving importmap undefined keeps the missing method.
function stubModuleSupport(support: { importmap?: boolean; modulepreload: boolean }) {
  if (support.importmap !== undefined) {
    vi.stubGlobal('HTMLScriptElement', { supports: (type: string) => type === 'importmap' && support.importmap })
  }
  vi.spyOn(DOMTokenList.prototype, 'supports').mockImplementation(token => token === 'modulepreload' && support.modulepreload)
}

// Runs the hero module's own source with import() replaced by `load`.
async function runHero(load: (url: string) => Promise<unknown>) {
  const source = heroScript().textContent ?? ''
  expect(source.split('import(')).toHaveLength(2)
  vi.stubGlobal('loadThree', load)
  await window.eval(`(async () => {\n${source.replace('import(', 'loadThree(')}\n})()`)
}

// The parts of Three.js the hero touches, recording each resize and draw.
function fakeThree() {
  const sizes: Array<[number, number]> = []
  let draws = 0
  class Vector3 {
    x = 0
    y = 0
    z = 0
    set(x: number, y: number, z: number) {
      Object.assign(this, { x, y, z })
    }
  }
  class Object3D {
    position = new Vector3()
    rotation = new Vector3()
    add() {}
  }
  class Color {
    set() {}
    copy() {}
  }
  class Material {
    color = new Color()
  }
  class Geometry {}
  const module = {
    WebGLRenderer: class {
      setPixelRatio() {}
      setSize(width: number, height: number) {
        sizes.push([width, height])
      }
      render() {
        draws += 1
      }
    },
    Scene: Object3D,
    Group: Object3D,
    Mesh: Object3D,
    PerspectiveCamera: class extends Object3D {
      aspect = 1
      updateProjectionMatrix() {}
    },
    InstancedMesh: class extends Object3D {
      setMatrixAt() {}
    },
    Matrix4: class {
      makeTranslation() {}
    },
    Color,
    MeshBasicMaterial: Material,
    IcosahedronGeometry: Geometry,
    TorusGeometry: Geometry,
    SphereGeometry: Geometry,
    DoubleSide: 2,
  }
  return { module, sizes, draws: () => draws }
}

// Boots the hero with a fake Three.js, a sized canvas and a captured ResizeObserver.
// Animation frames come from the fake timers (vi.advanceTimersToNextFrame).
async function startHero(reduceMotion: boolean) {
  boot()
  stubModuleSupport({ importmap: true, modulepreload: true })
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && reduceMotion,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })))
  const canvas = document.querySelector<HTMLCanvasElement>('#agent-visual')!
  const size = { width: 640, height: 480 }
  Object.defineProperty(canvas, 'clientWidth', { configurable: true, get: () => size.width })
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, get: () => size.height })
  let observeResize = () => {}
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) {
      observeResize = callback
    }
    observe() {}
  })
  // Keeps the palette observer from outliving this test's page.
  vi.stubGlobal('MutationObserver', class { observe() {} })
  const three = fakeThree()
  await runHero(() => Promise.resolve(three.module))
  // The hero hides its canvas when anything throws, including a gap in the fake.
  expect(canvas.hidden).toBe(false)
  return { three, size, observeResize: () => observeResize() }
}

function button(selector: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(selector)
  if (!element) throw new Error(`Missing marketing control: ${selector}`)
  return element
}

function boot(options: { dark?: boolean; query?: string; clipboard?: boolean } = {}) {
  window.history.replaceState({}, '', `/${options.query ?? ''}`)
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query.includes('prefers-color-scheme') && Boolean(options.dark),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })))
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: options.clipboard === false ? undefined : { writeText },
  })
  const html = readFileSync(pagePath, 'utf8')
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  document.documentElement.innerHTML = parsed.documentElement.innerHTML
  for (const attribute of [...document.documentElement.attributes]) {
    document.documentElement.removeAttribute(attribute.name)
  }
  document.documentElement.lang = 'en'
  for (const script of document.querySelectorAll('script:not([type])')) {
    window.eval(script.textContent ?? '')
  }
  return { html, writeText }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.innerHTML = ''
})

describe('local marketing page', () => {
  it('has a complete, self-contained light-first page with no live inbox connection', () => {
    const { html } = boot({ dark: true })
    expect(document.title).toContain('Agent Inbox')
    expect(document.querySelector('.release-line .version')?.textContent).toBe('v1.4.1')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.querySelectorAll('h1')).toHaveLength(1)
    expect(document.querySelector('h1')?.textContent).toContain('every terminal.')
    expect(document.querySelector('a.skip-link')?.getAttribute('href')).toBe('#main')
    expect(document.querySelector('#demo')?.textContent).toContain('Sample data')
    expect(document.querySelectorAll('script[src], link[rel="stylesheet"], iframe')).toHaveLength(0)
    expect(html).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/)
    expect(html).not.toMatch(/https?:\/\/(?:localhost|127\.0\.0\.1):4319/)
    expect(html).not.toContain('Not affiliated with GitHub or Anthropic.')
    expect(html).not.toContain('with no account to create')
    expect(html).not.toContain("Working and idle statuses don't add to your attention count.")
    expect(html).not.toContain('Interactive demo. Try a response; nothing is sent.')
    expect(html).not.toContain('Connect your CLI through MCP.')
    expect(document.querySelector('a[href="https://shariq.dev"]')?.textContent).toBe('Shariq Hirani')
    expect(document.querySelector('a[href="https://github.com/shariqh/agent-inbox"]')).not.toBeNull()
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
      expect(document.getElementById(link.hash.slice(1)), `Broken link ${link.hash}`).not.toBeNull()
    }
  })

  it('includes a palette-matched Three.js visual with a motion-safe fallback', () => {
    const { html } = boot()
    const canvas = document.querySelector<HTMLCanvasElement>('#agent-visual')
    expect(canvas).not.toBeNull()
    expect(canvas?.getAttribute('aria-hidden')).toBe('true')
    expect(heroScript().textContent).toContain(`await import('${THREE_MODULE}')`)
    expect(html).toContain("matchMedia('(prefers-reduced-motion: reduce)')")
    expect(html).toContain('var(--cp-accent)')
  })

  it('pins every Three.js module the hero loads with Subresource Integrity', () => {
    boot()
    const maps = document.querySelectorAll('script[type="importmap"]')
    expect(maps).toHaveLength(1)
    const map = JSON.parse(maps[0]!.textContent ?? '')
    expect(map.integrity).toEqual(PINNED)
    // The jsDelivr URLs map to themselves; every other https module URL, such as
    // a redirect target's relative ./three.core.js, is blocked.
    expect(map.imports).toEqual({ [THREE_MODULE]: THREE_MODULE, [THREE_CORE]: THREE_CORE, 'https://': null })

    const preloads = [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')]
    expect(preloads.map(link => [link.getAttribute('href'), link.getAttribute('integrity'), link.getAttribute('crossorigin')]))
      .toEqual(Object.entries(PINNED).map(([url, integrity]) => [url, integrity, 'anonymous']))

    const hero = heroScript()
    const source = hero.textContent ?? ''
    expect(source).not.toMatch(/^\s*import[\s{*]/m)
    expect([...source.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)].map(match => match[1])).toEqual([THREE_MODULE])

    const order = [...document.querySelectorAll('script, link')]
    const first = (selector: string) => order.findIndex(element => element.matches(selector))
    expect(first('script[type="importmap"]')).toBeLessThan(first('link[rel="modulepreload"]'))
    expect(order.indexOf(preloads.at(-1)!)).toBeLessThan(order.indexOf(hero))
  })

  it('keeps the plain hero and a working demo when Three.js cannot load', async () => {
    boot()
    const canvas = document.querySelector<HTMLCanvasElement>('#agent-visual')
    expect(canvas?.hidden).toBe(false)
    stubModuleSupport({ importmap: true, modulepreload: true })
    const load = vi.fn((url: string) => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${url}`)))

    await runHero(load)

    expect(load).toHaveBeenCalledWith(THREE_MODULE)
    expect(canvas?.hidden).toBe(true)
    button('#tab-plans').click()
    expect(button('#tab-plans').getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('#panel-plans')?.getAttribute('aria-hidden')).toBe('false')
  })

  it.each([
    ['has no HTMLScriptElement.supports', { modulepreload: true }],
    ['lacks import maps', { importmap: false, modulepreload: true }],
    ['lacks module preloads', { importmap: true, modulepreload: false }],
  ])('keeps the plain hero without loading Three.js when the browser %s', async (_, support) => {
    boot()
    stubModuleSupport(support)
    const load = vi.fn((_url: string) => Promise.resolve({}))

    await runHero(load)

    expect(load).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLCanvasElement>('#agent-visual')?.hidden).toBe(true)
  })

  it('resizes the hero renderer only when the canvas size changes', async () => {
    const hero = await startHero(false)
    expect(hero.three.sizes).toEqual([[640, 480]])
    vi.advanceTimersToNextFrame()
    vi.advanceTimersToNextFrame()
    expect(hero.three.draws()).toBe(3)
    expect(hero.three.sizes).toEqual([[640, 480]])

    hero.size.width = 800
    vi.advanceTimersToNextFrame()
    expect(hero.three.sizes).toEqual([[640, 480], [800, 480]])
    expect(hero.three.draws()).toBe(4)

    // A resize seen between frames repaints at once instead of showing a cleared canvas.
    hero.size.width = 960
    hero.observeResize()
    expect(hero.three.sizes).toEqual([[640, 480], [800, 480], [960, 480]])
    expect(hero.three.draws()).toBe(5)
    vi.advanceTimersToNextFrame()
    expect(hero.three.sizes).toHaveLength(3)
    expect(hero.three.draws()).toBe(6)
  })

  it('redraws a reduced-motion hero after its canvas is resized', async () => {
    const hero = await startHero(true)
    vi.advanceTimersToNextFrame()
    expect(hero.three.draws()).toBe(1)

    hero.size.height = 360
    hero.observeResize()
    expect(hero.three.sizes).toEqual([[640, 480], [640, 360]])
    expect(hero.three.draws()).toBe(2)

    hero.observeResize()
    expect(hero.three.sizes).toHaveLength(2)
    expect(hero.three.draws()).toBe(2)
  })

  it('keeps demo panels and response space mounted so interactions do not resize the demo', () => {
    const { html } = boot()
    const panels = [...document.querySelectorAll<HTMLElement>('.demo-panel')]
    expect(panels).toHaveLength(3)
    expect(panels.every(panel => !panel.hidden)).toBe(true)
    expect(document.querySelectorAll('.demo-panel.is-active')).toHaveLength(1)
    expect(document.querySelector('#panel-plans')?.getAttribute('aria-hidden')).toBe('true')
    expect(html).toContain('.demo-panel[aria-hidden="true"]')
    expect(html).toContain('.receipt[hidden]')
    // The reserved receipt space is a minimum in em, so enlarged text grows it instead of being clipped.
    const receiptRules = [...html.matchAll(/\.receipt \{([^}]*)\}/g)].map(match => match[1]!)
    expect(receiptRules.filter(rule => /\bmin-block-size: [\d.]+em;/.test(rule))).toHaveLength(2)
    expect(receiptRules.filter(rule => /(?:^|[;\s])block-size:/.test(rule))).toEqual([])

    button('#tab-plans').click()
    expect(document.querySelectorAll('.demo-panel.is-active')).toHaveLength(1)
    expect(document.querySelector('#panel-plans')?.getAttribute('aria-hidden')).toBe('false')
    expect(panels.every(panel => !panel.hidden)).toBe(true)

    button('#tab-inbox').click()
    button('#decision-options button').click()
    expect(document.querySelector<HTMLElement>('#receipt')?.hidden).toBe(false)
    expect(panels.every(panel => !panel.hidden)).toBe(true)
  })

  it('states the concrete problems solved and labels maintainer usage honestly', () => {
    boot()
    const proofElement = document.querySelector('#proof')
    const proof = proofElement?.textContent ?? ''
    const stats = [...(proofElement?.querySelectorAll('.proof-stat') ?? [])].map(
      stat => stat.textContent?.replace(/\s+/g, ' ').trim(),
    )
    expect(stats).toContain('389requests captured')
    expect(stats).toContain('145plans tracked')
    expect(stats).toContain('1,008plan rows kept with their outcomes')
    expect(stats).toContain('62–77%smaller agent-read payload estimates in internal scenarios')
    expect(proof).toContain('Based on maintainer usage')
    expect(proof).toContain('One queue across projects')
    expect(proof).toContain('From request to outcome')
    expect(proof).toContain('Durable plans.')
    expect(proof).not.toContain('Durable plans, not transcripts.')
  })

  it('respects an explicit dark preview and supports the appearance control', () => {
    boot({ query: '?scoutTheme=dark' })
    expect(document.documentElement.dataset.theme).toBe('dark')
    button('#theme-toggle').click()
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(button('#theme-toggle').getAttribute('aria-label')).toContain('dark')
  })

  it('reuses the original app artwork at every branding location', () => {
    boot()
    const source = new DOMParser().parseFromString(
      readFileSync(resolve('assets/icon.svg'), 'utf8'), 'text/html',
    ).querySelector('svg')
    const mark = document.getElementById('mark')
    if (!source || !mark) throw new Error('Missing app artwork')
    function contents(root: Element): unknown[] {
      return [...root.children].map(element => ({
        name: element.localName,
        attributes: Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value])),
        children: contents(element),
      }))
    }
    expect(mark.getAttribute('viewBox')).toBe(source.getAttribute('viewBox'))
    expect(contents(mark)).toEqual(contents(source))
    const brandIcons = document.querySelectorAll('.brand-mark use')
    expect(brandIcons).toHaveLength(5)
    for (const icon of brandIcons) expect(icon.getAttribute('href')).toBe('#mark')
  })

  it('shows the selected sample question and updates the decision controls', () => {
    boot()
    expect(document.querySelector('#question-title')?.textContent).toBe('Which sign-in approach should I use?')
    button('[data-question="release"]').click()
    expect(document.querySelector('#question-title')?.textContent).toBe('Ready to publish the release notes?')
    expect(button('[data-question="release"]').getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('#decision-options')?.textContent).toContain('Publish as written')
    expect(button('[data-question="auth"]').getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps a demo answer separate from agent pickup and can replay without network writes', () => {
    boot()
    button('#decision-options button').click()
    expect(document.querySelector('#receipt')?.textContent).toContain('Use the existing provider')
    expect(document.querySelector('#receipt')?.textContent).toContain('Waiting for agent pickup')
    expect(document.querySelector('#attention-count')?.textContent).toBe('2')
    expect(document.querySelectorAll('#decision-options button:disabled')).toHaveLength(2)
    expect(document.querySelector('#demo-announcement')?.textContent).toContain('Demo response recorded')
    button('#demo-reset').click()
    expect(document.querySelector('#attention-count')?.textContent).toBe('3')
    expect(document.querySelector<HTMLElement>('#receipt')?.hidden).toBe(true)
    expect(document.querySelectorAll('#decision-options button:disabled')).toHaveLength(0)
  })

  it('moves keyboard focus to the receipt when a demo answer replaces the chosen button', () => {
    boot()
    const choice = button('#decision-options button')
    choice.focus()
    choice.click()
    expect(choice.isConnected).toBe(false)
    expect(document.activeElement).toBe(document.querySelector('#receipt'))
  })

  it('retains each sample response when switching between questions', () => {
    boot()
    button('#decision-options button').click()
    button('[data-question="release"]').click()
    expect(document.querySelector<HTMLElement>('#receipt')?.hidden).toBe(true)
    button('#decision-options button').click()
    expect(document.querySelector('#attention-count')?.textContent).toBe('1')
    button('[data-question="auth"]').click()
    expect(document.querySelector('#receipt')?.textContent).toContain('Use the existing provider')
    expect(document.querySelector('#attention-count')?.textContent).toBe('1')
  })

  it('shows a task-shaped action without pretending it is an agent completion', () => {
    boot()
    button('[data-question="keys"]').click()
    expect(document.querySelector('#question-title')?.textContent).toBe('Add the staging API key')
    expect(document.querySelectorAll('#decision-options button')).toHaveLength(1)
    expect(button('#decision-options button').textContent).toContain("I've done my part")
    button('#decision-options button').click()
    expect(document.querySelector('#receipt')?.textContent).toContain('Waiting for agent pickup')
  })

  it('explains conditional current-head previews and quiet background refresh', () => {
    boot()
    const preview = document.querySelector<HTMLElement>('#question-preview')
    expect(preview?.hidden).toBe(true)
    button('[data-question="release"]').click()
    expect(preview?.hidden).toBe(false)
    expect(preview?.textContent).toContain('Preview link · current PR')
    button('[data-question="keys"]').click()
    expect(preview?.hidden).toBe(true)

    const features = document.querySelector('#features')?.textContent ?? ''
    expect(features).toContain('successful, non-production GitHub deployment metadata')
    expect(features).toContain('without pulling keyboard focus away from chat or another app')

    const previewFaq = [...document.querySelectorAll('details.faq-item')].find(
      item => item.querySelector('summary')?.textContent?.includes('Preview link'),
    )
    expect(previewFaq?.textContent).toContain('open approval question')
    expect(previewFaq?.textContent).toContain('blocked approval plan row')
    expect(previewFaq?.textContent).toContain('successful, explicitly non-production deployment')
    expect(previewFaq?.textContent).toContain('current PR head')
    expect(previewFaq?.textContent).toContain('Missing, stale, or conflicting records')
    expect(previewFaq?.textContent).toContain('approval controls stay available')
  })

  it('links the sample plan to a parent issue whose child progress matches its rows', () => {
    boot()
    const plan = document.querySelector('#panel-plans')
    const chip = plan?.querySelector('.issue-chip')
    const rows = [...(plan?.querySelectorAll('.plan-row') ?? [])]
    const done = rows.filter(row => row.querySelector('.state-pill')?.textContent === 'Done')
    expect(chip?.querySelector('[aria-hidden="true"]')?.textContent).toBe(`#42 · ${done.length}/${rows.length}`)
    expect(chip?.querySelector('.sr-only')?.textContent).toBe('Linked to GitHub issue #42, with 2 of 4 sub-issues done.')
    expect(rows.map(row => row.querySelector('.issue-crumb [aria-hidden="true"]')?.textContent))
      .toEqual(['#42 › #43', '#42 › #44', '#42 › #45', '#42 › #46'])
    expect(rows.map(row => row.querySelector('.issue-crumb .sr-only')?.textContent)).toEqual([
      'Issue #43, a sub-issue of #42.',
      'Issue #44, a sub-issue of #42.',
      'Issue #45, a sub-issue of #42.',
      'Issue #46, a sub-issue of #42.',
    ])
    expect(document.querySelectorAll('#demo a')).toHaveLength(0)
  })

  it('describes sub-issues, verified in-app updates, and long Copilot waits without overclaiming', () => {
    boot()
    const plans = [...document.querySelectorAll('.feature-aside')].find(
      aside => aside.querySelector('h3')?.textContent === 'Keep decisions with their plans.',
    )?.textContent ?? ''
    expect(plans).toContain('An agent can link a plan to a GitHub issue.')
    expect(plans).toContain("lists the issue's sub-issues and how many are done")
    expect(plans).toContain('rows linked to a sub-issue show their parent')
    expect(plans).toContain('through your signed-in GitHub CLI')
    expect(plans).not.toContain('Boards')

    const desktop = document.querySelector('.desktop-install')?.textContent ?? ''
    expect(desktop).toContain('In the macOS app and the Linux AppImage, Settings → Updates can download a new release')
    expect(desktop).toContain('check it against the signed release manifest')
    expect(desktop).toContain('when you choose Install and restart')
    expect(desktop).toContain("Setup's Update agents button then moves your agents to the new version.")

    const faq = (summary: string) => [...document.querySelectorAll('details.faq-item')].find(
      item => item.querySelector('summary')?.textContent === summary,
    )?.textContent ?? ''
    const pickup = faq('How does an agent receive my answer?')
    expect(pickup).toContain(`On a Copilot CLI request, choose "I'll take a while"`)
    expect(pickup).toContain('stop waiting, or to wait quietly for a few hours or until tomorrow')
    expect(pickup).toContain('If it stops, message it after you answer.')
    expect(pickup).toContain('The request stays in your inbox.')
    const privacy = faq('Does my inbox leave my machine?')
    expect(privacy).toContain('Optional update checks and downloads contact GitHub')
    expect(privacy).toContain('pull request and issue lookups when the GitHub CLI is installed and signed in')
    expect(privacy).not.toContain('Optional update checks and pull request lookups contact GitHub.')
  })

  it('supports feature tabs with keyboard navigation and an exposed selected state', () => {
    boot()
    const inbox = button('#tab-inbox')
    inbox.focus()
    inbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement?.id).toBe('tab-plans')
    expect(button('#tab-plans').getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector<HTMLElement>('#panel-inbox')?.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector<HTMLElement>('#panel-plans')?.getAttribute('aria-hidden')).toBe('false')
    expect(document.querySelector('#panel-plans')?.textContent).toContain('Ship the customer portal')
    button('#tab-plans').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(document.activeElement?.id).toBe('tab-live')
    expect(document.querySelector<HTMLElement>('#panel-live')?.getAttribute('aria-hidden')).toBe('false')
    button('#tab-live').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(document.activeElement?.id).toBe('tab-inbox')
  })

  it('copies the exact setup commands and reports clipboard failures honestly', async () => {
    const { writeText } = boot()
    button('#copy-command').click()
    await vi.runAllTimersAsync()
    expect(writeText).toHaveBeenCalledWith(document.querySelector('#install-command')?.textContent)
    expect(document.querySelector('#copy-status')?.textContent).toContain('Copied')
    writeText.mockRejectedValueOnce(new Error('Clipboard denied'))
    button('#copy-command').click()
    await vi.runAllTimersAsync()
    expect(document.querySelector('#copy-status')?.textContent).toContain('Select and copy')
  })

  it('builds the required entrypoints before previewing source setup', () => {
    boot()
    const commands = document.querySelector('#install-command')?.textContent?.split('\n') ?? []
    const build = commands.indexOf('npm run build')
    const preview = commands.indexOf('npm run install:agents')
    expect(build).toBeGreaterThan(-1)
    expect(preview).toBeGreaterThan(build)
    expect(commands).not.toContain('npm run install:agents -- --apply')
  })

  it('provides a manual-copy fallback when the clipboard is unavailable', async () => {
    boot({ clipboard: false })
    button('#copy-command').click()
    await vi.runAllTimersAsync()
    expect(document.querySelector('#copy-status')?.textContent).toContain('Select and copy')
  })

  it('closes the mobile navigation on Escape and restores the trigger focus', () => {
    boot()
    button('#menu-toggle').click()
    expect(button('#menu-toggle').getAttribute('aria-expanded')).toBe('true')
    document.querySelector<HTMLAnchorElement>('#site-nav a')?.focus()
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(button('#menu-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement?.id).toBe('menu-toggle')
  })

  it('keeps small-screen reflow, focus, and reduced-motion rules in the standalone file', () => {
    const { html } = boot()
    expect(html).toContain('prefers-reduced-motion')
    expect(html).toContain(':focus-visible')
    expect(html).toContain('@media (max-width: 640px)')
    expect(html).toContain('minmax(0, 1fr)')
    expect(document.querySelectorAll('details.faq-item')).toHaveLength(6)
    for (const element of document.querySelectorAll('button')) {
      expect(element.getAttribute('aria-label') || element.textContent?.trim()).toBeTruthy()
    }
  })
})
