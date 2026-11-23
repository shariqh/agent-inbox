// The chats' styles (#586 PR 2; Find's Chats chip since UX pass, slice 4, step B), pinned on the
// stylesheet source: jsdom returns var() unresolved and never matches a container query.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'public/style.css'), 'utf8')

const ruleBody = (selector: string, from = 0): string => {
  const at = css.indexOf(`${selector} {`, from)
  if (at < 0) return ''
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
}
const findStart = css.indexOf('@container find (max-width: 620px) {')
const findBlock = css.slice(findStart, css.indexOf('\n}\n', findStart))

describe('chats styles (#586 PR 2; step B)', () => {
  it('has no page of its own any more: no container, table or search box of the Chats page', () => {
    expect(css).not.toMatch(/@container chats-list/)
    expect(css).not.toMatch(/\.chats-table|\.chats-search|\.chats-count|#chats\b/)
  })

  it('reserves the slot beside a chat row’s main button at one fixed width, so a label change never moves the row', () => {
    const space = ruleBody('.find-slot-space')
    for (const rule of [/flex:\s*none;/, /width:\s*var\(--find-slot\);/, /height:\s*var\(--find-slot-h\);/]) expect(space).toMatch(rule)
    const slot = ruleBody('.find-slot')
    for (const rule of [/position:\s*absolute;/, /width:\s*var\(--find-slot\);/, /height:\s*var\(--find-slot-h\);/]) expect(slot).toMatch(rule)
    // laid over the space: right of it are the age and the project columns, at their fixed widths
    expect(slot).toMatch(/right:\s*calc\(18px \+ var\(--find-age\) \+ 14px \+ var\(--find-project\) \+ 14px\);/)
    // the slot's button fills it and cuts a long label rather than growing
    const button = ruleBody('.find-slot > button')
    for (const rule of [/min-width:\s*0;/, /overflow:\s*hidden;/, /text-overflow:\s*ellipsis;/, /margin:\s*0;/]) expect(button).toMatch(rule)
    expect(ruleBody('.find-row')).toMatch(/position:\s*relative;/)
    expect(ruleBody('.find')).toMatch(/--find-slot:\s*152px;/)
  })

  it('stacks a narrow chat row with its slot at the first line’s end, in Find’s own container query', () => {
    expect(findStart).toBeGreaterThan(0)
    expect(ruleBody('.find-slot-space', findStart)).toMatch(/grid-area:\s*new;/)
    expect(ruleBody('.find-slot', findStart)).toMatch(/right:\s*18px;/)
    expect(ruleBody('.find-live', findStart)).toMatch(/grid-area:\s*extra;/)
    expect(findBlock).not.toMatch(/order:/)
  })

  it('never reorders with CSS order, and nothing about a chat enters or leaves the layout on hover or focus', () => {
    const rules = [...css.matchAll(/^\s*([^{}\n]*(?:\.chats-|\.find-slot|\.find-live|\.find-chats)[^{}\n]*)\{([^}]*)\}/gm)]
    expect(rules.length).toBeGreaterThan(15)
    for (const [, selector, body] of rules) {
      expect(body, selector).not.toMatch(/(^|[\s;])order:/)
      if (/:hover|:focus/.test(selector!)) expect(body, selector).not.toMatch(/display|width|height|position|margin|padding/)
    }
  })

  it('takes every font size, gap and padding of the chats’ own rules from the tokens', () => {
    const rules = [...css.matchAll(/^\s*([^{}\n]*\.chats-[^{}\n]*)\{([^}]*)\}/gm)]
    expect(rules.length).toBeGreaterThan(15)
    for (const [, selector, body] of rules) {
      for (const [, property, value] of body!.matchAll(/(font-size|gap|padding|row-gap|column-gap):\s*([^;]+);/g)) {
        expect(value!.replace(/var\(--(?:fs|sp)-[\w-]+\)|\b0\b/g, '').trim(), `${selector!.trim()} ${property}`).toBe('')
      }
    }
  })

  it('wraps long unbroken text in an open row’s facts', () => {
    expect(ruleBody('.chats-facts dd')).toMatch(/overflow-wrap:\s*anywhere;/)
    expect(ruleBody('.chats-facts')).toMatch(/grid-template-columns:\s*auto minmax\(0, 1fr\);/)
  })

  it('draws a quiet title muted and Live in the agent color', () => {
    expect(ruleBody('.chats-quiet')).toMatch(/color:\s*var\(--app-muted\);/)
    expect(ruleBody('.chip.chats-live')).toMatch(/color:\s*var\(--app-agent\);/)
    expect(ruleBody('.find-live')).toMatch(/color:\s*var\(--app-agent\);/)
  })

  it('draws every chat control alike, wrapping in the open row with its note on a line of its own', () => {
    const button = ruleBody('.chats-copy, .chats-resume, .chats-continue, .chats-show, .chats-jump')
    for (const rule of [/padding:\s*var\(--sp-1\) var\(--sp-2\);/, /font-size:\s*var\(--fs-meta\);/, /white-space:\s*nowrap;/]) expect(button).toMatch(rule)
    expect(ruleBody('.chats-copy[aria-disabled="true"], .chats-resume[aria-disabled="true"], .chats-continue[aria-disabled="true"], .chats-refresh[aria-disabled="true"]')).toMatch(/opacity:\s*\.45;/)
    const actions = ruleBody('\n.chats-actions')
    for (const rule of [/display:\s*flex;/, /flex-wrap:\s*wrap;/, /gap:\s*var\(--sp-2\);/]) expect(actions).toMatch(rule)
    const note = ruleBody('.chats-resume-note')
    for (const rule of [/flex:\s*1 1 100%;/, /font-size:\s*var\(--fs-meta\);/, /white-space:\s*normal;/]) expect(note).toMatch(rule)
    expect(note).not.toMatch(/\d+px/)
    expect(ruleBody('.chats-resume-note:empty')).toMatch(/display:\s*none;/)
    // a visible focus ring on each control, in the focus color both themes define
    expect(ruleBody('.chats-copy:focus-visible, .chats-resume:focus-visible, .chats-continue:focus-visible, .chats-show:focus-visible, .chats-jump:focus-visible, .sp-chat-link:focus-visible'))
      .toMatch(/outline:\s*2px solid var\(--app-focus\);/)
    // "· here" in the agent color, at the meta size
    const here = ruleBody('.chats-here')
    for (const rule of [/margin-left:\s*var\(--sp-1\);/, /color:\s*var\(--app-agent\);/, /font-size:\s*var\(--fs-meta\);/]) expect(here).toMatch(rule)
  })

  it('takes the dialog’s chat facts and the panel’s chat line from the tokens (#586 phase 2)', () => {
    const rules = [...css.matchAll(/^\s*([^{}\n]*(?:\.launch-chat-facts|\.sp-chat|\.chats-here)[^{}\n]*)\{([^}]*)\}/gm)]
    expect(rules.length).toBeGreaterThanOrEqual(5)
    for (const [, selector, body] of rules) {
      for (const [, property, value] of body!.matchAll(/(font-size|gap|padding|row-gap|column-gap|margin|margin-left):\s*([^;]+);/g)) {
        expect(value!.replace(/var\(--(?:fs|sp)-[\w-]+\)|\b0\b/g, '').trim(), `${selector!.trim()} ${property}`).toBe('')
      }
      // a focus ring's outline is the app's one 2px ring, not a size or a gap
      if (!selector!.includes(':focus-visible')) expect(body, selector).not.toMatch(/\d+px/)
    }
  })

  it('lets [hidden] win over the parts that set a display', () => {
    const hidden = ruleBody('.chats-note[hidden], .chats-error[hidden], .chats-state[hidden], .chats-actions[hidden], .chats-facts [hidden]')
    expect(hidden).toMatch(/display:\s*none;/)
    expect(ruleBody('.find-chats[hidden], .find-chats-foot[hidden]')).toMatch(/display:\s*none;/)
  })
})
