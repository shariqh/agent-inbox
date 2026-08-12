import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd())
const html = readFileSync(resolve(root, 'public/index.html'), 'utf8')
const css = readFileSync(resolve(root, 'public/style.css'), 'utf8')

describe('the editorial desk shell', () => {
  it('is light-first, warm, and uses the approved desktop typography', () => {
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light\s*;/s)
    expect(css).toContain('--app-bg: #f7f4ef')
    expect(css).toContain('"Segoe UI", Aptos, Calibri')
    expect(css).not.toContain('mediumpurple')
    expect(css).not.toContain('rebeccapurple')
  })

  it('moves navigation into a real sidebar and gives the work area an editorial heading', () => {
    expect(html).toContain('class="sidebar-shell"')
    expect(html).toContain('id="pageTitle"')
    expect(html).toContain('Your queue')
    expect(html).toContain('>Inbox<span class="tab-count"')
    expect(html).toContain('>Plans<span class="tab-count"')
    expect(html).toContain('>History<span class="tab-count"')
  })

  it('presents an expanded queue card as the desktop inspector without moving its DOM', () => {
    expect(css).toMatch(/\.nrow-card\s*\{[^}]*position:\s*fixed\s*;/s)
    expect(css).toContain('--inspector-width: 520px')
    expect(css).toMatch(/\.nrow-card\s*\{[^}]*width:\s*var\(--inspector-width\)\s*;/s)
    expect(css).toMatch(/#needsYouList\s*\{[^}]*padding-right:\s*calc\(var\(--inspector-width\)/s)
  })

  it('exposes keyboard-accessible splitters for both adjustable panes', () => {
    expect(html).toMatch(/id="sidebarResize"[^>]*role="separator"/)
    expect(html).toMatch(/id="inspectorResize"[^>]*role="separator"/)
    expect(css).toMatch(/\.pane-resizer\s*\{/)
    expect(css).toMatch(/@media \(max-width: 1279px\)[\s\S]*\.pane-resizer\s*\{[^}]*display:\s*none/s)
  })

  it('keeps compact plan rows inside the viewport', () => {
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    expect(compact).toMatch(/\.board-table\.matrix\s*\{[^}]*table-layout:\s*fixed/s)
    expect(compact).toMatch(/\.board-table\.matrix \.row-note\s*\{[^}]*display:\s*none/s)
    expect(compact).toMatch(/\.board-table\.matrix \.row-label\s*\{[^}]*text-overflow:\s*ellipsis/s)
  })

  it('composes compact navigation as one masthead with a readable project strip', () => {
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    expect(html).toContain('id="projectDisclosureToggle"')
    expect(compact).toMatch(/\.sidebar-shell\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto/s)
    expect(compact).toMatch(/#tabs\s*\{[^}]*grid-column:\s*2[^}]*width:\s*max-content/s)
    expect(compact).toMatch(/\.sidebar-section-label\s*\{[^}]*display:\s*block/s)
    expect(compact).toMatch(/#rail\s*\{[^}]*grid-column:\s*2\s*\/\s*-1/s)
    expect(compact).toMatch(/#rail \.rail-name\s*\{[^}]*text-overflow:\s*ellipsis/s)
    expect(compact).toMatch(/@container compact-masthead \(max-width:\s*620px\)[\s\S]*#tabs \.tab-count\s*\{[^}]*display:\s*none/s)
    expect(compact).toMatch(/#projectDisclosure\[data-open="true"\] #rail\s*\{[^}]*display:\s*flex/s)
  })

  it('contains the tablet archived-project popover without changing the desktop rail', () => {
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    expect(compact).toMatch(/\.project-disclosure\.tablet-projects\s*\{[^}]*position:\s*relative/s)
    expect(compact).toMatch(/\.project-disclosure\.tablet-projects #rail \.rail-close\s*\{[^}]*display:\s*inline-flex[^}]*min-height:\s*30px/s)
    expect(compact).toMatch(/\.closed-projects-popover\s*\{[^}]*position:\s*absolute[^}]*right:\s*0[^}]*width:\s*min\(360px,\s*calc\(100vw - 24px\)\)[^}]*max-height:\s*min\(420px,\s*calc\(100vh - 180px\)\)[^}]*overflow-y:\s*auto/s)
    expect(compact).toMatch(/#rail \.rail-close,\s*#rail \.rail-reopen\s*\{[^}]*display:\s*none/s)
    expect(compact).toMatch(/@container compact-masthead \(max-width:\s*620px\)[\s\S]*\.closed-projects-trigger\s*\{[^}]*display:\s*none/s)
    expect(css.slice(0, css.indexOf('@media (max-width: 1279px)'))).not.toContain('.tablet-projects')
  })

  it('lets the compact page heading and tools share a row before wrapping', () => {
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    expect(compact).toMatch(/#topbar\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s)
    expect(compact).toMatch(/\.page-heading\s*\{[^}]*flex:\s*0 1 auto/s)
    expect(compact).toMatch(/\.topbar-tools\s*\{[^}]*flex:\s*1 1 440px/s)
  })
})
