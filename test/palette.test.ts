import { describe, expect, it } from 'vitest'
import { paletteResults } from '../public/palette.js'
import type { PaletteTarget } from '../public/palette.js'

// A plain substring matcher: the palette only needs the injected engine's shape.
const contains = (hay: string[], needle: string) =>
  hay.flatMap((text, index) => (text.includes(needle.toLowerCase()) ? [{ index, ranges: [] }] : []))

const target = (key: string, title: string, action: PaletteTarget['action']): PaletteTarget =>
  ({ key, title, context: 'alpha · copilot', haystack: `${title} alpha copilot`.toLowerCase(), action })
const targets = {
  asks: [target('item:q1', 'Ship the lanes?', { type: 'answer', id: 'q1' }), target('row:r1', 'Approve the spec', { type: 'answer', id: 'r1' })],
  plans: [target('board:b1', 'Dashboard plan', { type: 'plan', id: 'b1' })],
  sessions: [target('session:s1', 'Painting lanes', { type: 'session', id: 's1' })],
}

describe('⌘K actions (#307)', () => {
  it('lists every target of a command typed with a space, and narrows by the rest', () => {
    expect(paletteResults('answer ', targets, contains).map((r) => r.key)).toEqual(['answer:item:q1', 'answer:row:r1'])
    expect(paletteResults('Answer approve', targets, contains).map((r) => r.title)).toEqual(['Approve the spec'])
    expect(paletteResults('open plan dash', targets, contains).map((r) => r.action)).toEqual([{ type: 'plan', id: 'b1' }])
    expect(paletteResults('jump to session paint', targets, contains).map((r) => r.action)).toEqual([{ type: 'session', id: 's1' }])
    expect(paletteResults('jump to session ', targets, contains)[0]).toMatchObject({ section: 'actions', sectionLabel: 'Actions', kind: 'Jump to session' })
    // only the full names are commands: a search that starts with a word of one stays a search
    for (const query of ['plan flow', 'plan ', 'session paint', 'jump paint', 'jump to paint']) {
      // at most a suggestion, which only fills in the full name
      expect(paletteResults(query, targets, contains).filter((r) => r.action.type !== 'command'), query).toEqual([])
    }
    expect(paletteResults('plan flow', targets, contains)).toEqual([])
  })

  it('suggests a command for a prefix of its name and never takes over a plain search', () => {
    expect(paletteResults('ans', targets, contains).map((r) => r.action)).toEqual([{ type: 'command', fill: 'answer ' }])
    expect(paletteResults('jump', targets, contains).map((r) => r.title)).toEqual(['Jump to session…'])
    expect(paletteResults('pla', targets, contains).map((r) => r.title)).toEqual(['Open plan…'])
    // a word without the space is a search, not a command
    expect(paletteResults('plan', targets, contains).map((r) => r.action.type)).toEqual(['command'])
    expect(paletteResults('a', targets, contains)).toEqual([])
    expect(paletteResults('lanes', targets, contains)).toEqual([])
    expect(paletteResults('answer nothing-like-it', targets, contains)).toEqual([])
  })
})
