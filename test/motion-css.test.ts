import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Dashboard 2.0 phase 0 (#302, proposal §10). jsdom never matches
// `@media (prefers-reduced-motion: reduce)`, so the motion rules are pinned on
// the stylesheet's source. The checker below is exercised on synthetic sheets
// too, so it cannot pass vacuously while the app has no animation yet.

const css = readFileSync(resolve(process.cwd(), 'public/style.css'), 'utf8')
const appJs = readFileSync(resolve(process.cwd(), 'public/app.js'), 'utf8')

type Rule = { selectors: string[]; decls: Map<string, string>; media: string | null }
type Keyframes = { name: string; props: Set<string> }

const REDUCED = /prefers-reduced-motion:\s*reduce/
const CALM = ':root[data-motion="calm"]'

function declarations(body: string): Map<string, string> {
  const decls = new Map<string, string>()
  for (const part of body.split(';')) {
    const colon = part.indexOf(':')
    if (colon < 0) continue
    const prop = part.slice(0, colon).trim().toLowerCase()
    if (prop) decls.set(prop, part.slice(colon + 1).trim())
  }
  return decls
}

function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  throw new Error('unbalanced braces')
}

function parse(source: string, media: string | null = null, out = { rules: [] as Rule[], keyframes: [] as Keyframes[] }) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open < 0) break
    const prelude = text.slice(i, open).trim()
    const end = closing(text, open)
    const body = text.slice(open + 1, end)
    if (/^@keyframes\s/.test(prelude)) {
      const props = new Set<string>()
      for (const frame of body.matchAll(/\{([^}]*)\}/g)) for (const prop of declarations(frame[1] ?? '').keys()) props.add(prop)
      out.keyframes.push({ name: prelude.replace(/^@keyframes\s+/, ''), props })
    } else if (prelude.startsWith('@')) {
      parse(body, prelude, out)
    } else {
      out.rules.push({ selectors: prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decls: declarations(body), media })
    }
    i = end + 1
  }
  return out
}

const isInfinite = (rule: Rule) => [...rule.decls].some(([prop, value]) => prop.startsWith('animation') && /\binfinite\b/.test(value))
const isNone = (rule: Rule) => /^none\b.*!important/.test(rule.decls.get('animation') ?? '')

/** Selectors with an infinite animation that the reduced-motion block or Calm leaves running. */
function uncoveredLoops(source: string): { reduced: string[]; calm: string[] } {
  const { rules } = parse(source)
  const reducedOff = new Set(rules.filter((r) => r.media && REDUCED.test(r.media) && isNone(r)).flatMap((r) => r.selectors))
  const calmOff = new Set(rules.filter((r) => !r.media && isNone(r)).flatMap((r) => r.selectors)
    .filter((s) => s.startsWith(`${CALM} `)).map((s) => s.slice(CALM.length + 1)))
  const loops = rules.filter((r) => isInfinite(r) && !(r.media && REDUCED.test(r.media)))
    .flatMap((r) => r.selectors).filter((s) => !s.startsWith(CALM))
  return { reduced: loops.filter((s) => !reducedOff.has(s)), calm: loops.filter((s) => !calmOff.has(s)) }
}

describe('motion checker discrimination', () => {
  it('finds an infinite animation the reduced-motion block does not list', () => {
    const sheet = `.lane .pulse::after { animation: m-pulse 2s ease-out infinite; }
      @media (prefers-reduced-motion: reduce) { .other { animation: none !important; } }
      ${CALM} .lane .pulse::after { animation: none !important; }`
    expect(uncoveredLoops(sheet)).toEqual({ reduced: ['.lane .pulse::after'], calm: [] })
  })

  it('finds one Calm leaves running, including a longhand iteration count', () => {
    const sheet = `.orbit { animation-name: m-spin; animation-iteration-count: infinite; }
      @media (prefers-reduced-motion: reduce) { .orbit, .x { animation: none !important; } }`
    expect(uncoveredLoops(sheet)).toEqual({ reduced: [], calm: ['.orbit'] })
  })

  it('accepts a loop listed in both places and ignores one-shot animations', () => {
    const sheet = `.now .orbit { animation: m-spin 6s linear infinite; }
      .landed.new { animation: m-arrive .5s ease-out both; }
      @media (prefers-reduced-motion: reduce) { .now .orbit { animation: none !important; } }
      ${CALM} .now .orbit { animation: none !important; }`
    expect(uncoveredLoops(sheet)).toEqual({ reduced: [], calm: [] })
  })

  it('does not count a listing without !important as switched off', () => {
    const sheet = `.lane .pulse::after { animation: m-pulse 2s ease-out infinite; }
      @media (prefers-reduced-motion: reduce) { .lane .pulse::after { animation: none; } }
      ${CALM} .lane .pulse::after { animation: none; }`
    expect(uncoveredLoops(sheet)).toEqual({ reduced: ['.lane .pulse::after'], calm: ['.lane .pulse::after'] })
  })

  it('reads keyframe properties so a background-position animation is caught', () => {
    const { keyframes } = parse('@keyframes drift { from { background-position: 0 0; } to { background-position: 16px 0; } }')
    expect([...keyframes[0]!.props]).toEqual(['background-position'])
  })
})

describe('motion foundation in public/style.css (#302)', () => {
  const { rules, keyframes } = parse(css)
  const root = rules.find((r) => r.selectors.length === 1 && r.selectors[0] === ':root' && !r.media)

  it('defines duration and easing tokens on :root', () => {
    for (const token of ['--motion-fast', '--motion-base', '--motion-moderate', '--motion-slow']) {
      expect(root?.decls.get(token), token).toMatch(/^\d+ms$/)
    }
    for (const token of ['--motion-ease', '--motion-ease-out', '--motion-ease-in-out', '--motion-linear']) {
      expect(root?.decls.get(token), token).toBeTruthy()
    }
  })

  it('takes every transition duration from a motion token', () => {
    const transitions = rules.filter((r) => !r.media || !REDUCED.test(r.media))
      .flatMap((r) => [...r.decls].filter(([prop]) => prop === 'transition' || prop === 'transition-duration'))
    expect(transitions.length).toBeGreaterThan(0)
    for (const [, value] of transitions) {
      expect(value).not.toMatch(/(^|[\s,])\.?\d+(\.\d+)?m?s\b/)
      expect(value).toMatch(/var\(--motion-/)
    }
  })

  it('has a reduced-motion block that makes one-shots instant', () => {
    const universal = rules.find((r) => r.media && REDUCED.test(r.media) && r.selectors.includes('*'))
    expect(universal, 'no @media (prefers-reduced-motion: reduce) block with a universal rule').toBeTruthy()
    expect(universal!.selectors).toEqual(['*', '*::before', '*::after'])
    expect(universal!.decls.get('animation-duration')).toBe('0s !important')
    expect(universal!.decls.get('animation-delay')).toBe('0s !important')
    expect(universal!.decls.get('animation-iteration-count')).toBe('1 !important')
    expect(universal!.decls.get('transition-duration')).toBe('0s !important')
    expect(universal!.decls.get('transition-delay')).toBe('0s !important')
    expect(universal!.decls.get('scroll-behavior')).toBe('auto !important')
  })

  it('turns every infinite animation off under reduced motion and under Calm', () => {
    expect(uncoveredLoops(css)).toEqual({ reduced: [], calm: [] })
  })

  it('pauses every animation while the page is hidden', () => {
    const hidden = rules.find((r) => !r.media && r.selectors[0] === ':root[data-page-hidden] *')
    expect(hidden?.selectors).toEqual([':root[data-page-hidden] *', ':root[data-page-hidden] *::before', ':root[data-page-hidden] *::after'])
    expect(hidden?.decls.get('animation-play-state')).toBe('paused !important')
  })

  it('animates only transform and opacity, never background-position', () => {
    for (const frames of keyframes) {
      expect([...frames.props].filter((p) => p !== 'transform' && p !== 'opacity'), `@keyframes ${frames.name}`).toEqual([])
    }
    for (const rule of rules) {
      for (const [prop, value] of rule.decls) {
        if (prop.startsWith('transition')) expect(value, rule.selectors.join(', ')).not.toMatch(/background-position|\ball\b/)
      }
    }
  })

  // #304: the sweep marks the latest activity, so it runs on one lane only;
  // laneMotion (test/lanes.test.ts) picks it and keeps every loop within 12.
  it('sweeps only the lane laneMotion picks as the newest call', () => {
    const sweeps = rules.filter((r) => !r.media && [...r.decls].some(([prop, value]) => prop.startsWith('animation') && /dash-lane-sweep/.test(value)))
    expect(sweeps.flatMap((r) => r.selectors)).toEqual(['.dash-lane.sweep::before'])
    expect(appJs.match(/classList\.toggle\('sweep'/g)).toEqual(["classList.toggle('sweep'"])
    expect(appJs).toContain("el.classList.toggle('sweep', motion.sweep === lane.session)")
  })

  it('scrolls through the motion controller instead of a literal smooth behaviour', () => {
    expect(appJs).not.toMatch(/behavior:\s*['"\x60]smooth/)
    const scrolls = appJs.match(/scrollIntoView\(\{ behavior: [^,}]+/g) ?? []
    expect(scrolls).toHaveLength(3)
    for (const call of scrolls) expect(call).toBe('scrollIntoView({ behavior: motion.scrollBehavior()')
  })
})
