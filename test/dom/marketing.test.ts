// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pagePath = resolve('marketing/index.html')

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
  document.documentElement.innerHTML = ''
})

describe('local marketing page', () => {
  it('has a complete, self-contained light-first page with no live inbox connection', () => {
    const { html } = boot({ dark: true })
    expect(document.title).toContain('Agent Inbox')
    expect(document.querySelector('.release-line .version')?.textContent).toBe('v1.2.5')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.querySelectorAll('h1')).toHaveLength(1)
    expect(document.querySelector('h1')?.textContent).toContain('every terminal.')
    expect(document.querySelector('a.skip-link')?.getAttribute('href')).toBe('#main')
    expect(document.querySelector('#demo')?.textContent).toContain('Interactive demo')
    expect(document.querySelector('#demo')?.textContent).toContain('Sample data')
    expect(document.querySelectorAll('script[src], link[rel="stylesheet"], iframe')).toHaveLength(0)
    expect(html).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/)
    expect(html).not.toMatch(/https?:\/\/(?:localhost|127\.0\.0\.1):4319/)
    expect(document.querySelector('a[href="https://github.com/shariqh/agent-inbox"]')).not.toBeNull()
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
      expect(document.getElementById(link.hash.slice(1)), `Broken link ${link.hash}`).not.toBeNull()
    }
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

  it('supports feature tabs with keyboard navigation and an exposed selected state', () => {
    boot()
    const inbox = button('#tab-inbox')
    inbox.focus()
    inbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement?.id).toBe('tab-plans')
    expect(button('#tab-plans').getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector<HTMLElement>('#panel-inbox')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('#panel-plans')?.hidden).toBe(false)
    expect(document.querySelector('#panel-plans')?.textContent).toContain('Ship the customer portal')
    button('#tab-plans').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(document.activeElement?.id).toBe('tab-live')
    expect(document.querySelector<HTMLElement>('#panel-live')?.hidden).toBe(false)
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
