// UX pass, slice 4: Find's stylesheet is one block at the end of public/style.css. Colours
// come from the theme's tokens only; the picture's sizes are named once; the narrow row
// follows the column's own width through a container query (the file keeps its single
// width @media); nothing is shown or hidden on hover or focus; no CSS `order`.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
const start = css.indexOf('/* UX pass, slice 4: Find.')
const block = css.slice(start)

describe('the Find stylesheet block', () => {
  it('is one block, last in the file', () => {
    expect(start).toBeGreaterThan(0)
    expect(css.indexOf('UX pass, slice 4', start + 20)).toBe(-1)
    expect(block).toContain('.note-editor')
    expect(block).toContain('.find-row-main')
  })

  it('uses tokens for every colour', () => {
    for (const declaration of block.matchAll(/(?:^|[;{\s])((?:background|color|border(?:-color)?|stroke|fill|outline)\s*:\s*[^;}]+)/g)) {
      const value = declaration[1]!.split(':').slice(1).join(':')
      expect(value, declaration[1]).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    }
  })

  it('names the picture’s sizes: a 780px column, a 64px field with 20px text, 34px chips, 58px rows, a 96px bar', () => {
    expect(block).toMatch(/--find-column:\s*780px/)
    expect(block).toMatch(/--find-field:\s*64px/)
    expect(block).toMatch(/\.find-query\s*\{[^}]*font-size:\s*20px/)
    expect(block).toMatch(/--find-chip:\s*34px/)
    expect(block).toMatch(/--find-row:\s*58px/)
    expect(block).toMatch(/--find-bar:\s*96px/)
    expect(block).toMatch(/--find-project:\s*92px/)
  })

  it('stacks the row under a container query at 620px, with no @media and no order', () => {
    expect(block).toMatch(/\.find\s*\{[^}]*container:\s*find \/ inline-size/)
    expect(block).toMatch(/@container find \(max-width: 620px\)\s*\{[^]*grid-template-areas:\s*"icon title title new" "\. extra project age"/)
    expect(block).not.toContain('@media')
    expect(block).not.toMatch(/(^|[;{\s])order\s*:/)
    expect([...css.matchAll(/@media \((?:max|min)-width/g)]).toHaveLength(1)
  })

  it('shows and hides nothing on hover or focus', () => {
    for (const rule of block.matchAll(/([^{}]*:(?:hover|focus|focus-within|focus-visible)[^{}]*)\{([^}]*)\}/g)) {
      expect(rule[2], rule[1]).not.toMatch(/display|visibility|opacity|width|height|content/)
    }
  })

  it('hides the top bar’s search where Find stands in for it', () => {
    expect(block).toMatch(/#topbar \.floating-search\[hidden\]\s*\{\s*display:\s*none/)
  })
})
