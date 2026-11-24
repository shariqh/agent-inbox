// The Agent cards tab at phone width: four tabs do not fit the narrow tab row with their names, so
// this tab keeps its icon only, by a container query on the masthead (never a second width query),
// and its name stays in its label and title.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const css = readFileSync(join(root, 'public', 'style.css'), 'utf8')
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8')

describe('the Agent cards tab in a phone-width tab row', () => {
  it('hides only its own name, inside the narrow layout, by the masthead container', () => {
    const rule = /@container compact-masthead \(max-width: 520px\) \{\s*\.tabstrip \.tab\[data-tab="cards"\] \.tab-name \{ display: none; \}\s*\}/.exec(css)
    expect(rule).not.toBeNull()
    // it sits inside the one responsive width query, not beside it
    const media = css.indexOf('@media (max-width: 1279px)')
    expect(media).toBeGreaterThan(-1)
    expect(rule!.index).toBeGreaterThan(media)
    expect(css.match(/@media \(max-width: \d+px\)/g)).toHaveLength(1)
    // no other tab loses its name there
    expect(css).not.toMatch(/@container compact-masthead[^{]*\{\s*\.tabstrip \.tab(?!\[data-tab="cards"\])[^{]*\.tab-name \{ display: none/)
  })

  it('tightens the tabs at the narrowest masthead so four fit without scrolling, and brings a chosen tab into the row', () => {
    const narrowest = css.slice(css.indexOf('@container compact-masthead (max-width: 440px)'))
    expect(narrowest.slice(0, 600)).toMatch(/#tabs \.tab \{ padding-inline: 7px; \}/)
    const app = readFileSync(join(root, 'public', 'app.js'), 'utf8')
    const select = app.slice(app.indexOf('function selectTab('), app.indexOf('function selectTab(') + 2600)
    expect(select).toContain("scrollIntoView?.({ block: 'nearest', inline: 'nearest' })")
  })

  it('wraps the tab in the element its container rule styles (a class the markup and the stylesheet must share)', () => {
    // the test DOM has no layout, so a mismatch here shows only as a full-width grid in the real app
    const wrapper = /<section class="panel" id="cards"[^>]*>\s*<div class="([^"]+)">/.exec(html)?.[1]
    expect(wrapper).toBe('agent-cards')
    expect(css).toMatch(/\.agent-cards \{\s*container: agent-cards \/ inline-size;/)
    expect(css).toMatch(/@container agent-cards \(max-width: 700px\)/)
    for (const name of ['agent-cards-home', 'agent-cards-off', 'agent-cards-agent']) {
      expect(html).toContain(`class="${name}"`)
      expect(css).toContain(`.${name}`)
    }
  })

  it('keeps the tab named when its text is not drawn', () => {
    const tab = /<button class="tab"[^>]*data-tab="cards"[^>]*>/.exec(html)?.[0] ?? ''
    expect(tab).toContain('aria-label="Agent cards"')
    expect(tab).toContain('title="Agent cards"')
    expect(html).toMatch(/data-tab="cards"[\s\S]{0,400}<span class="tab-name">Agent cards<\/span>/)
  })
})
