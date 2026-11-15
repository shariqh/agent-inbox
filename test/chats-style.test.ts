// The Chats tab's styles (#586 PR 2), pinned on the stylesheet source: jsdom
// returns var() unresolved and never matches a container query.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'public/style.css'), 'utf8')

const ruleBody = (selector: string, from = 0): string => {
  const at = css.indexOf(`${selector} {`, from)
  if (at < 0) return ''
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
}
const containerStart = css.indexOf('@container chats-list (max-width: 620px) {')
const containerBlock = css.slice(containerStart, css.indexOf('\n}\n', containerStart))

describe('Chats tab styles (#586 PR 2)', () => {
  it('makes the list its own container', () => {
    expect(ruleBody('#chats .chats')).toMatch(/container:\s*chats-list \/ inline-size;/)
  })

  it('lays each row out on two lines below 620px', () => {
    expect(containerStart).toBeGreaterThan(0)
    expect(ruleBody('.chats-table thead', containerStart)).toMatch(/clip-path:\s*inset\(50%\)/)
    const tr = ruleBody('.chats-table tr', containerStart)
    for (const rule of [/display:\s*flex;/, /flex-wrap:\s*wrap;/]) expect(tr).toMatch(rule)
    const td = ruleBody('.chats-table td', containerStart)
    for (const rule of [/display:\s*block;/, /min-width:\s*0;/, /overflow-wrap:\s*anywhere;/, /order:\s*2;/]) expect(td).toMatch(rule)
    // the project filter: a line of its own, with a select that can shrink
    expect(ruleBody('label.chats-project', containerStart)).toMatch(/flex:\s*1 1 100%;[^}]*min-width:\s*0;/)
    expect(ruleBody('label.chats-project select', containerStart)).toMatch(/min-width:\s*0;/)
    // line 1: tool, title, Live (order 0); a full-width break (order 1); line 2: the rest
    expect(ruleBody('.chats-table tr::after', containerStart)).toMatch(/flex:\s*0 0 100%;[^}]*order:\s*1;/)
    expect(ruleBody('.chats-table .chats-tool, .chats-table .chats-title, .chats-table .chats-live', containerStart)).toMatch(/order:\s*0;/)
    // the folder takes the slack, so it is never squeezed to nothing at phone width
    expect(ruleBody('.chats-table .chats-folder', containerStart)).toMatch(/flex:\s*1 1 12em;/)
    expect(containerBlock).not.toMatch(/grid-template-columns/)
    expect(containerBlock).not.toMatch(/\.chats-[\w-]+[^{]*\{[^}]*display:\s*none/)
  })

  it('takes every font size, gap and padding from the tokens', () => {
    const rules = [...css.matchAll(/^\s*([^{}\n]*\.chats-[^{}\n]*)\{([^}]*)\}/gm)]
    expect(rules.length).toBeGreaterThan(15)
    for (const [, selector, body] of rules) {
      for (const [, property, value] of body!.matchAll(/(font-size|gap|padding|row-gap|column-gap):\s*([^;]+);/g)) {
        expect(value!.replace(/var\(--(?:fs|sp)-[\w-]+\)|\b0\b/g, '').trim(), `${selector!.trim()} ${property}`).toBe('')
      }
    }
  })

  it('wraps long unbroken text in every free-text column of the wide table', () => {
    expect(ruleBody('.chats-title, .chats-project, .chats-branch, .chats-folder')).toMatch(/overflow-wrap:\s*anywhere;/)
  })

  it('draws a quiet title muted and Live in the agent color', () => {
    expect(ruleBody('.chats-quiet')).toMatch(/color:\s*var\(--app-muted\);/)
    expect(ruleBody('.chip.chats-live')).toMatch(/color:\s*var\(--app-agent\);/)
  })

  it('draws Resume as Copy resume is drawn, with its note under both (PR 3)', () => {
    const button = ruleBody('.chats-copy, .chats-resume')
    for (const rule of [/padding:\s*var\(--sp-1\) var\(--sp-2\);/, /font-size:\s*var\(--fs-meta\);/, /white-space:\s*nowrap;/]) expect(button).toMatch(rule)
    expect(ruleBody('.chats-copy[aria-disabled="true"], .chats-resume[aria-disabled="true"], .chats-refresh[aria-disabled="true"]')).toMatch(/opacity:\s*\.45;/)
    // its own rule, not the one it shares with Copy resume
    expect(ruleBody('\n.chats-resume')).toMatch(/margin-right:\s*var\(--sp-1\);/)
    const note = ruleBody('.chats-resume-note')
    for (const rule of [/display:\s*block;/, /margin-top:\s*var\(--sp-1\);/, /font-size:\s*var\(--fs-meta\);/]) expect(note).toMatch(rule)
    expect(note).not.toMatch(/\d+px/)
    expect(ruleBody('.chats-resume-note:empty')).toMatch(/display:\s*none;/)
  })

  it('lets [hidden] win over the parts that set a display', () => {
    const hidden = ruleBody('.chats-note[hidden], .chats-error[hidden], .chats-count[hidden], .chats-state[hidden], .chats-table[hidden]')
    expect(hidden).toMatch(/display:\s*none;/)
  })
})
