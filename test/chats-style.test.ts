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
    expect(tr).toMatch(/display:\s*grid;/)
    const td = ruleBody('.chats-table td', containerStart)
    for (const rule of [/display:\s*block;/, /min-width:\s*0;/, /overflow-wrap:\s*anywhere;/]) expect(td).toMatch(rule)
    // line 1: tool, title, Live; line 2: project, branch, folder, last active, Copy
    const row = (cls: string) => /grid-area:\s*(\d)/.exec(ruleBody(`.chats-${cls}`, containerStart))?.[1]
    expect(['tool', 'title', 'live'].map(row)).toEqual(['1', '1', '1'])
    expect(['project', 'branch', 'folder', 'active', 'actions'].map(row)).toEqual(['2', '2', '2', '2', '2'])
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

  it('draws a quiet title muted and Live in the agent color', () => {
    expect(ruleBody('.chats-quiet')).toMatch(/color:\s*var\(--app-muted\);/)
    expect(ruleBody('.chip.chats-live')).toMatch(/color:\s*var\(--app-agent\);/)
  })

  it('lets [hidden] win over the parts that set a display', () => {
    const hidden = ruleBody('.chats-note[hidden], .chats-error[hidden], .chats-count[hidden], .chats-state[hidden], .chats-table[hidden]')
    expect(hidden).toMatch(/display:\s*none;/)
  })
})
