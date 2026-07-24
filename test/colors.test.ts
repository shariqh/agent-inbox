import { describe, it, expect } from 'vitest'
import {
  projectColor,
  projectMonogram,
  projectHue,
  assignedHue,
  overrideHue,
  PROJECT_HUES,
  RESERVED_HUE,
  HUE_STORE_KEY,
} from '../public/colors.js'

const OKLCH = /^oklch\((0|1|0\.\d+) (0|0\.\d+) (\d+(?:\.\d+)?)\)$/

function parts(css: string): { l: number; c: number; h: number } {
  const m = OKLCH.exec(css)
  expect(m, `not an oklch() triple: ${css}`).not.toBeNull()
  return { l: Number(m![1]), c: Number(m![2]), h: Number(m![3]) }
}

// OKLCH → linear sRGB → WCAG relative luminance. Real math, no library: the
// legibility claim has to be COMPUTED, not eyeballed. Out-of-gamut components
// are clamped exactly as a browser clamps them.
function linearRgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (x: number) => Math.min(1, Math.max(0, x))
  return [
    clamp(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    clamp(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    clamp(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
  ]
}

function luminance(css: string): number {
  const { l, c, h } = parts(css)
  const [r, g, b] = linearRgb(l, c, h)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(x: string, y: string): number {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p)
  return (hi! + 0.05) / (lo! + 0.05)
}

// what the page sits on in each theme, so "contrast" means something concrete
const BG = { light: 'oklch(1 0 0)', dark: 'oklch(0.18 0 0)' } as const
const MIN_HUE_STEP = 15 // adjacent palette entries must be this far apart
// a hair under the WCAG 3:1 non-text floor: the dot is never the sole carrier
// (the monogram is, §2) and gamut clamping costs a little on the greens
const MIN_CONTRAST = 2.5

describe('projectColor', () => {
  it('returns oklch dot and wash strings', () => {
    const c = projectColor('agent-inbox', 'light')
    expect(c.dot).toMatch(OKLCH)
    expect(c.wash).toMatch(OKLCH)
  })
  it('is deterministic — same name, same colors', () => {
    expect(projectColor('agent-inbox', 'light')).toEqual(projectColor('agent-inbox', 'light'))
    expect(projectColor('agent-inbox', 'dark')).toEqual(projectColor('agent-inbox', 'dark'))
  })
  it('gives different names different hues (no global collapse)', () => {
    const hues = new Set(['api', 'web', 'agent-inbox', 'solo', 'ubi', 'billing'].map(projectHue))
    expect(hues.size).toBeGreaterThan(1)
  })
  it('keeps the same hue across themes but changes lightness/chroma', () => {
    const light = parts(projectColor('agent-inbox', 'light').dot)
    const dark = parts(projectColor('agent-inbox', 'dark').dot)
    expect(dark.h).toBe(light.h)
    expect(dark.l).not.toBe(light.l)
    expect(projectColor('agent-inbox', 'dark')).not.toEqual(projectColor('agent-inbox', 'light'))
  })
  it('uses one fixed lightness/chroma per theme for every project', () => {
    const a = parts(projectColor('api', 'light').dot)
    const b = parts(projectColor('billing', 'light').dot)
    expect(a.l).toBe(b.l)
    expect(a.c).toBe(b.c)
  })
  it('the wash is far lighter than the dot in light theme and far darker in dark theme', () => {
    expect(parts(projectColor('api', 'light').wash).l).toBeGreaterThan(parts(projectColor('api', 'light').dot).l)
    expect(parts(projectColor('api', 'dark').wash).l).toBeLessThan(parts(projectColor('api', 'dark').dot).l)
  })
  it('the dot and the wash share the project hue', () => {
    const c = projectColor('agent-inbox', 'light')
    expect(parts(c.wash).h).toBe(parts(c.dot).h)
  })
  it('NEVER generates a hue in the reserved red/amber/orange band', () => {
    for (const h of PROJECT_HUES) {
      expect(h < RESERVED_HUE.start || h > RESERVED_HUE.end, `palette hue ${h} is in the reserved band`).toBe(true)
    }
    for (let i = 0; i < 500; i++) {
      for (const theme of ['light', 'dark'] as const) {
        const c = projectColor(`project-${i}`, theme)
        for (const css of [c.dot, c.wash]) {
          const { h } = parts(css)
          expect(h < RESERVED_HUE.start || h > RESERVED_HUE.end, `${css} is in the reserved band`).toBe(true)
        }
      }
    }
  })
  it('spreads names across the whole palette', () => {
    const used = new Set<number>()
    for (let i = 0; i < 500; i++) used.add(projectHue(`project-${i}`))
    expect(used.size).toBe(PROJECT_HUES.length)
  })
  it('falls back to the light theme for an unknown theme string', () => {
    // @ts-expect-error deliberately passing an invalid theme
    expect(projectColor('api', 'sepia')).toEqual(projectColor('api', 'light'))
  })
})

describe('assignedHue / overrideHue', () => {
  it('assigns the hashed hue on first sight and persists it', () => {
    const store: Record<string, string> = {}
    const first = assignedHue('agent-inbox', store)
    expect(first).toBe(projectHue('agent-inbox'))
    expect(store[HUE_STORE_KEY], 'nothing was written back').toBeDefined()
    expect(JSON.parse(store[HUE_STORE_KEY]!)['agent-inbox']).toBe(first)
    expect(assignedHue('agent-inbox', store)).toBe(first)
  })
  it('a stored assignment beats the hash, so a project never changes color', () => {
    const other = PROJECT_HUES.find((h) => h !== projectHue('api'))!
    const store: Record<string, string> = { [HUE_STORE_KEY]: JSON.stringify({ api: other }) }
    expect(assignedHue('api', store)).toBe(other)
  })
  it('an override wins over both the hash and an earlier assignment', () => {
    const store: Record<string, string> = {}
    assignedHue('api', store)
    const pinned = PROJECT_HUES.find((h) => h !== projectHue('api'))!
    expect(overrideHue('api', pinned, store)).toBe(pinned)
    expect(assignedHue('api', store)).toBe(pinned)
    expect(parts(projectColor('api', 'light', store).dot).h).toBe(pinned)
    expect(parts(projectColor('api', 'dark', store).wash).h).toBe(pinned)
  })
  it('rejects a hue outside the palette — the reserved band stays state-only', () => {
    expect(() => overrideHue('api', 40, {})).toThrow(/PROJECT_HUES/)
  })
  it('a cleared store re-derives from the hash', () => {
    const store: Record<string, string> = {}
    overrideHue('api', PROJECT_HUES.find((h) => h !== projectHue('api'))!, store)
    delete store[HUE_STORE_KEY]
    expect(assignedHue('api', store)).toBe(projectHue('api'))
  })
  it('works with a localStorage-shaped store', () => {
    const backing = new Map<string, string>()
    const store = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
    }
    const h = assignedHue('web', store)
    expect(h).toBe(projectHue('web'))
    expect(JSON.parse(backing.get(HUE_STORE_KEY)!).web).toBe(h)
    expect(assignedHue('web', store)).toBe(h)
  })
  it('survives corrupt storage by falling back to the hash', () => {
    const store: Record<string, string> = { [HUE_STORE_KEY]: '{not json' }
    expect(assignedHue('api', store)).toBe(projectHue('api'))
  })
  it('ignores a stored hue that is no longer in the palette', () => {
    const store: Record<string, string> = { [HUE_STORE_KEY]: JSON.stringify({ api: 7 }) }
    expect(assignedHue('api', store)).toBe(projectHue('api'))
  })
  it('projectColor without a store never touches persistence', () => {
    const store: Record<string, string> = {}
    projectColor('api', 'light')
    expect(store[HUE_STORE_KEY]).toBeUndefined()
  })
})

describe('palette legibility', () => {
  it('separates adjacent palette entries by at least 15° of hue', () => {
    for (let i = 1; i < PROJECT_HUES.length; i++) {
      const step = PROJECT_HUES[i]! - PROJECT_HUES[i - 1]!
      expect(step, `hues ${PROJECT_HUES[i - 1]} and ${PROJECT_HUES[i]} are too close`).toBeGreaterThanOrEqual(MIN_HUE_STEP)
    }
  })
  it('holds lightness and chroma constant per theme, so hue is the only variable', () => {
    for (const theme of ['light', 'dark'] as const) {
      const store: Record<string, string> = {}
      const dots = PROJECT_HUES.map((hue) => {
        overrideHue('probe', hue, store)
        return parts(projectColor('probe', theme, store).dot)
      })
      expect(new Set(dots.map((d) => d.l)).size, `${theme} dots vary in lightness`).toBe(1)
      expect(new Set(dots.map((d) => d.c)).size, `${theme} dots vary in chroma`).toBe(1)
    }
  })
  it('clears the contrast floor for dot vs wash AND dot vs page in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const store: Record<string, string> = {}
      for (const hue of PROJECT_HUES) {
        overrideHue('probe', hue, store)
        const c = projectColor('probe', theme, store)
        expect(contrast(c.dot, c.wash), `${theme} hue ${hue}: dot on wash`).toBeGreaterThanOrEqual(MIN_CONTRAST)
        expect(contrast(c.dot, BG[theme]), `${theme} hue ${hue}: dot on page`).toBeGreaterThanOrEqual(MIN_CONTRAST)
      }
    }
  })
})

describe('projectMonogram', () => {
  it('takes the initials of the first two words', () => {
    expect(projectMonogram('agent-inbox')).toBe('AI')
    expect(projectMonogram('my project x')).toBe('MP')
    expect(projectMonogram('coreworx/ubi')).toBe('CU')
  })
  it('takes the first two letters of a single word', () => {
    expect(projectMonogram('solo')).toBe('SO')
    expect(projectMonogram('unknown')).toBe('UN')
  })
  it('never exceeds two characters', () => {
    for (const n of ['a b c d', 'averyverylongprojectname', 'x', '', '---']) {
      expect(projectMonogram(n).length).toBeLessThanOrEqual(2)
    }
  })
  it('falls back to ? when there is nothing alphanumeric', () => {
    expect(projectMonogram('')).toBe('?')
    expect(projectMonogram('---')).toBe('?')
  })
})
