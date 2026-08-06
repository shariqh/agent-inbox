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
})
