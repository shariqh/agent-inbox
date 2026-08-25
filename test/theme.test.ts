import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  THEME_STORAGE_KEY,
  createThemeController,
  readThemePreference,
  resolveTheme,
  saveThemePreference,
} from '../public/theme.js'

type Listener = (event: { matches: boolean }) => void

function media(initial = false) {
  const listeners = new Set<Listener>()
  return {
    matches: initial,
    addEventListener(_type: string, listener: Listener) { listeners.add(listener) },
    removeEventListener(_type: string, listener: Listener) { listeners.delete(listener) },
    set(matches: boolean) {
      this.matches = matches
      for (const listener of listeners) listener({ matches })
    },
  }
}

function store(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key: string) { return values.get(key) ?? null },
    setItem(key: string, value: string) { values.set(key, value) },
    value(key: string) { return values.get(key) ?? null },
  }
}

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channels = hex.match(/[0-9a-f]{2}/gi)?.map((part) => Number.parseInt(part, 16) / 255) ?? []
    const linear = channels.map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4)
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

function themeTokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [match[1]!, match[2]!]),
  )
}

function declaredThemeTokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+)\s*;/g)].map((match) => [match[1]!, match[2]!.trim()]),
  )
}

describe('theme preference model', () => {
  it('defaults invalid, missing, and unreadable preferences to Dark', () => {
    expect(readThemePreference(store())).toBe('dark')
    expect(readThemePreference(store({ [THEME_STORAGE_KEY]: 'sepia' }))).toBe('dark')
    expect(readThemePreference({ getItem() { throw new Error('denied') } })).toBe('dark')
  })

  it('persists only Light, Dark, or System', () => {
    const storage = store()
    expect(saveThemePreference(storage, 'dark')).toBe('dark')
    expect(storage.value(THEME_STORAGE_KEY)).toBe('dark')
    expect(saveThemePreference(storage, 'system')).toBe('system')
    expect(storage.value(THEME_STORAGE_KEY)).toBe('system')
    // @ts-expect-error deliberately exercising runtime validation
    expect(() => saveThemePreference(storage, 'sepia')).toThrow(/theme preference/i)
  })

  it('resolves System from OS appearance while explicit choices ignore it', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('system', true)).toBe('dark')
  })

  it('reacts live to OS changes only while System is selected', () => {
    const storage = store({ [THEME_STORAGE_KEY]: 'system' })
    const root = { dataset: {} as Record<string, string> }
    const query = media(false)
    const changes: Array<[string, string]> = []
    const controller = createThemeController({
      storage,
      root,
      media: query,
      onChange: (preference, effective) => changes.push([preference, effective]),
    })

    expect(root.dataset).toMatchObject({ theme: 'light', themePreference: 'system' })
    query.set(true)
    expect(root.dataset.theme).toBe('dark')

    controller.setPreference('light')
    query.set(false)
    query.set(true)
    expect(root.dataset.theme).toBe('light')
    expect(changes).toEqual([
      ['system', 'light'],
      ['system', 'dark'],
      ['light', 'light'],
    ])
    controller.destroy()
  })

  it('keeps the active preference when persistence fails', () => {
    const query = media(false)
    const root = { dataset: {} as Record<string, string> }
    const controller = createThemeController({
      storage: {
        getItem: () => 'dark',
        setItem() { throw new Error('quota exceeded') },
      },
      root,
      media: query,
    })

    expect(() => controller.setPreference('light')).toThrow(/quota exceeded/)
    expect(controller.preference).toBe('dark')
    expect(root.dataset.theme).toBe('dark')
  })
})

describe('early theme bootstrap and palette', () => {
  const root = resolve(process.cwd())
  const html = readFileSync(resolve(root, 'public/index.html'), 'utf8')
  const bootstrap = readFileSync(resolve(root, 'public/theme-bootstrap.js'), 'utf8')
  const css = readFileSync(resolve(root, 'public/style.css'), 'utf8')

  it('runs the theme bootstrap before loading the stylesheet', () => {
    expect(html.indexOf('/theme-bootstrap.js')).toBeGreaterThan(0)
    expect(html.indexOf('/theme-bootstrap.js')).toBeLessThan(html.indexOf('/style.css'))
  })

  it('applies a saved Dark preference synchronously before paint', () => {
    const document = { documentElement: { dataset: {} as Record<string, string> } }
    const localStorage = { getItem: () => 'dark' }
    const window = { matchMedia: () => ({ matches: false }) }
    new Function('window', 'document', 'localStorage', bootstrap)(window, document, localStorage)
    expect(document.documentElement.dataset).toMatchObject({
      theme: 'dark',
      themePreference: 'dark',
    })
  })

  it('derives both semantic palettes from the approved Live Operations Desk identity', () => {
    const light = declaredThemeTokens(css, ':root {')
    const dark = declaredThemeTokens(css, ':root[data-theme="dark"]')

    expect(light).toMatchObject({
      'brand-ink-900': '#211013',
      'brand-ink-700': '#391b20',
      'brand-envelope': '#5b3036',
      'brand-flap': '#6d3b43',
      'brand-coral-600': '#d76298',
      'brand-coral-400': '#eb84bb',
      'brand-coral-200': '#f6a6d1',
      'app-bg': '#edf0f2',
      'app-elevated': '#f7f8f9',
      'app-surface': '#ffffff',
      'app-soft': '#f1f3f4',
      'app-border': '#d8dde2',
      'app-border-strong': '#7b858f',
      'app-text': '#15191d',
      'app-muted': '#4f5861',
      'app-text-soft': '#5f6a74',
      'app-accent': '#b03f26',
      'app-accent-hover': '#96341f',
      'app-accent-soft': 'rgba(176, 63, 38, .10)',
      'app-attention': '#b03f26',
      'app-agent': '#087f72',
      'app-plan': '#8c6f00',
      'app-outcome': '#237c42',
      'app-link': '#087f72',
      'app-focus': '#087f72',
      'app-action-secondary': '#087f72',
      'app-on-accent': '#ffffff',
      'app-code-border': '#7c8791',
      'app-danger': '#b93643',
      'app-code-error': '#b93643',
    })
    expect(dark).toMatchObject({
      'app-bg': '#090b0d',
      'app-elevated': '#101214',
      'app-surface': '#15181b',
      'app-soft': '#1a1e22',
      'app-border': '#2b3036',
      'app-border-strong': '#68737e',
      'app-text': '#f4f6f8',
      'app-muted': '#b2b8bf',
      'app-text-soft': '#8f99a3',
      'app-accent': '#ff7a59',
      'app-accent-hover': '#ff9278',
      'app-accent-soft': 'rgba(255, 122, 89, .13)',
      'app-attention': '#ff7a59',
      'app-agent': '#38d6c0',
      'app-plan': '#e7c54b',
      'app-outcome': '#77d995',
      'app-link': '#72e1d2',
      'app-focus': '#7ed7ff',
      'app-action-secondary': '#72e1d2',
      'app-on-accent': '#24100c',
      'app-code-border': '#69737d',
      'app-code-error': '#ff8b94',
    })
  })

  it('keeps normal text at 4.5:1 and structural/interactive colors at 3:1', () => {
    for (const [name, selector] of [['light', ':root {'], ['dark', ':root[data-theme="dark"]']] as const) {
      const token = themeTokens(css, selector)
      for (const surface of ['app-bg', 'app-surface', 'app-elevated', 'app-soft'] as const) {
        expect(contrast(token['app-text']!, token[surface]!), `${name} text on ${surface}`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(token['app-muted']!, token[surface]!), `${name} muted on ${surface}`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(token['app-text-soft']!, token[surface]!), `${name} soft text on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
      for (const semantic of ['app-accent', 'app-success', 'app-danger', 'app-warning', 'app-link'] as const) {
        expect(contrast(token[semantic]!, token['app-surface']!), `${name} ${semantic}`).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrast(token['app-border-strong']!, token['app-surface']!), `${name} strong border`).toBeGreaterThanOrEqual(3)
      expect(contrast(token['app-on-accent']!, token['app-accent']!), `${name} on-accent text`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(token['app-code-border']!, token['app-soft']!), `${name} code control boundary`).toBeGreaterThanOrEqual(3)
      expect(contrast(token['app-code-error']!, token['app-soft']!), `${name} code error`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(token['app-success']!, token['app-soft']!), `${name} code success`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps important states distinguishable by more than color', () => {
    expect(css).toMatch(/\.nrow\.answered\s*\{[^}]*opacity:/s)
    expect(css).toMatch(/\.nrow\.selected \.nrow-title\s*\{[^}]*font-weight:\s*700/s)
    expect(css).toMatch(/button:disabled\s*\{[^}]*cursor:[^}]*opacity:/s)
    expect(css).toMatch(/tr:has\(\.blocked\) \.row-label\s*\{[^}]*font-weight:/s)
    expect(css).toMatch(/\.outcome-label\s*\{[^}]*text-transform:/s)
  })

  it('themes fenced commands only through the semantic palette', () => {
    const start = css.indexOf('.structured-code {')
    const end = css.indexOf('.card-meta', start)
    const rules = css.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(rules).toContain('var(--app-soft)')
    expect(rules).toContain('var(--app-surface)')
    expect(rules).toContain('var(--app-text)')
    expect(rules).toContain('var(--app-success)')
    expect(rules).toContain('var(--app-code-border)')
    expect(rules).toContain('var(--app-code-error)')
    expect(rules).toContain('var(--app-focus)')
    expect(rules).not.toMatch(/\b(?:Canvas|CanvasText|LinkText|seagreen|crimson)\b/)
  })
})
