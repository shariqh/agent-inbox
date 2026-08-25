import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd())
const html = readFileSync(resolve(root, 'public/index.html'), 'utf8')
const css = readFileSync(resolve(root, 'public/style.css'), 'utf8')

describe('the editorial desk shell', () => {
  it('is dark-first, graphite with icon-derived accent, and uses the approved operations typography', () => {
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light\s*;/s)
    expect(html).toContain('<html lang="en" data-theme="dark">')
    expect(css).toContain('--app-bg: #090b0d')
    expect(css).toContain('--app-agent: #38d6c0')
    expect(css).toContain('--app-accent: #eb84bb')
    expect(css).toContain('ui-sans-serif')
    expect(css).toContain('"Segoe UI Variable"')
    expect(css).not.toContain('mediumpurple')
    expect(css).not.toContain('rebeccapurple')
  })

  it('moves navigation into a real sidebar and gives the work area an editorial heading', () => {
    expect(html).toContain('class="sidebar-shell"')
    expect(html).toContain('id="pageTitle"')
    expect(html).toContain('Live Operations Desk')
    expect(html).toContain('class="tab-name">Dashboard</span>')
    expect(html).toContain('class="tab-name">Inbox</span><span class="tab-count"')
    expect(html).toContain('class="tab-name">Plans</span><span class="tab-count"')
    expect(html).toContain('class="tab-name">History</span><span class="tab-count"')
  })

  it('keeps workspace search in the utility bar and gives the sidebar ownership of the agent picker', () => {
    const sidebar = html.slice(html.indexOf('<aside class="sidebar-shell">'), html.indexOf('</aside>'))
    const topbar = html.slice(html.indexOf('<header id="topbar">'), html.indexOf('</header>'))
    expect(sidebar).toContain('class="agent-pick"')
    expect(sidebar.indexOf('class="agent-pick"')).toBeGreaterThan(sidebar.indexOf('id="projectDisclosure"'))
    expect(sidebar.indexOf('class="agent-pick"')).toBeLessThan(sidebar.indexOf('id="gear"'))
    expect(topbar).not.toContain('class="agent-pick"')
    expect(topbar).toContain('id="search"')
    expect(html).toMatch(/class="floating-search"[^>]*role="search"[\s\S]*id="search"[^>]*aria-keyshortcuts="Meta\+K Control\+K"/)
    expect(css).toMatch(/#topbar\s*\{[^}]*grid-template-columns:\s*minmax\(180px,\s*1fr\)\s+minmax\(280px,\s*520px\)/s)
    expect(css).toMatch(/\.floating-search\s*\{[^}]*position:\s*relative[^}]*width:\s*100%/s)
    expect(css).toMatch(/\.search-results\s*\{[^}]*top:\s*calc\(100% \+ 8px\)[^}]*bottom:\s*auto/s)
    expect(css).toMatch(/\.agent-pick\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)[^}]*border-top:\s*1px solid var\(--app-border\)/s)
    expect(css).toMatch(/\.nrow-card\s*\{[^}]*bottom:\s*104px/s)
  })

  it('keeps the archive × inside its project row and reveals it only on direct hover or keyboard focus', () => {
    const desktop = css.slice(0, css.indexOf('@media (max-width: 1279px)'))
    expect(desktop).toMatch(/\.rail-row\s*\{[^}]*position:\s*relative/s)
    expect(desktop).toMatch(/\.rail-row > \.rail-close\s*\{[^}]*position:\s*absolute[^}]*right:\s*4px[^}]*top:\s*50%/s)
    expect(desktop).toMatch(/\.rail-close,\s*\.rail-reopen\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s)
    expect(desktop).toMatch(/\.rail-row:hover \.rail-close,\s*\.rail-row:focus-within \.rail-close,\s*\.rail-close:focus-visible\s*\{[^}]*opacity:\s*\.65[^}]*pointer-events:\s*auto/s)
    expect(css).not.toMatch(/\.rail-close \.rail-action-glyph\s*\{[^}]*display:\s*none/s)
    expect(css).not.toMatch(/\.rail-close \.rail-action-label\s*\{[^}]*display:\s*inline/s)
  })

  it('presents an expanded queue card as the desktop inspector without moving its DOM', () => {
    expect(css).toMatch(/\.nrow-card\s*\{[^}]*position:\s*fixed\s*;/s)
    expect(css).toContain('--inspector-width: 520px')
    expect(css).toMatch(/\.nrow-card\s*\{[^}]*width:\s*var\(--inspector-width\)\s*;/s)
    expect(css).toMatch(/#needsYouList\s*\{[^}]*padding-right:\s*calc\(var\(--inspector-width\)/s)
    expect(css).toMatch(/\.nrow-card-compose\s*\{[^}]*max-height:\s*min\(50%,\s*360px\)[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s)
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

  it('composes compact navigation as one masthead with a single project menu', () => {
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    const masthead = compact.slice(0, compact.indexOf('@container compact-masthead'))
    expect(html).toContain('id="projectDisclosureToggle"')
    expect(masthead).toMatch(/\.app-shell\s*\{[^}]*container:\s*compact-masthead\s*\/\s*inline-size/s)
    expect(masthead).not.toMatch(/\.sidebar-shell\s*\{[^}]*container:\s*compact-masthead/s)
    expect(compact).toMatch(/\.sidebar-shell\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) minmax\(180px,\s*240px\) minmax\(130px,\s*180px\) auto[^}]*grid-template-rows:\s*auto/s)
    expect(compact).toMatch(/#tabs\s*\{[^}]*grid-column:\s*2[^}]*width:\s*max-content/s)
    expect(masthead).toMatch(/\.sidebar-section-label\s*\{[^}]*display:\s*none/s)
    expect(masthead).toMatch(/\.sidebar-shell \.project-disclosure\s*\{[^}]*position:\s*relative[^}]*display:\s*block[^}]*grid-column:\s*3[^}]*grid-row:\s*1/s)
    expect(masthead).toMatch(/\.sidebar-shell \.agent-pick\s*\{[^}]*grid-column:\s*4[^}]*grid-row:\s*1/s)
    expect(masthead).toMatch(/\.sidebar-shell \.project-disclosure-toggle\s*\{[^}]*display:\s*flex/s)
    expect(masthead).toMatch(/#projectDisclosure #rail\s*\{[^}]*position:\s*absolute[^}]*display:\s*none[^}]*flex-direction:\s*column[^}]*overflow-y:\s*auto[^}]*overscroll-behavior-y:\s*contain/s)
    expect(masthead).toMatch(/#projectDisclosure\[data-open="true"\] #rail\s*\{[^}]*display:\s*flex/s)
    expect(masthead).not.toMatch(/#rail\s*\{[^}]*overflow-x:\s*auto/s)
    expect(compact).toMatch(/#projectDisclosure #rail \.rail-name\s*\{[^}]*text-overflow:\s*ellipsis/s)
    expect(compact).toMatch(/@container compact-masthead \(max-width:\s*900px\)[\s\S]*\.sidebar-shell \.project-disclosure\s*\{[^}]*grid-column:\s*1\s*\/\s*3[^}]*grid-row:\s*2[\s\S]*\.sidebar-shell \.agent-pick\s*\{[^}]*grid-column:\s*3\s*\/\s*5[^}]*grid-row:\s*2/s)
    expect(compact).toMatch(/@container compact-masthead \(max-width:\s*620px\)[\s\S]*#tabs\s*\{[^}]*display:\s*flex[^}]*grid-column:\s*1\s*\/\s*-1[^}]*grid-row:\s*2[^}]*overflow-x:\s*auto/s)
    expect(compact).toMatch(/@container compact-masthead \(max-width:\s*620px\)[\s\S]*#tabs \.tab-count\s*\{[^}]*display:\s*inline-block/s)
    expect(compact).toMatch(/@container compact-masthead \(max-width:\s*620px\)[\s\S]*\.sidebar-shell \.project-disclosure\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*3[\s\S]*\.sidebar-shell \.agent-pick\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*3/s)
    expect(compact).toMatch(/@container compact-masthead \(max-width:\s*440px\)[\s\S]*\.sidebar-shell\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*grid-template-rows:\s*auto auto auto[\s\S]*\.sidebar-shell \.project-disclosure\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*3[\s\S]*\.sidebar-shell \.agent-pick\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*3/s)
  })

  it('collapses the wide sidebar into an icon rail without changing compact mastheads', () => {
    expect(html).toMatch(/id="sidebarCollapse"[^>]*aria-expanded="true"/)
    expect(css).toMatch(/body\.sidebar-collapsed \.sidebar-shell\s*\{[^}]*padding:/s)
    expect(css).toMatch(/body\.sidebar-collapsed \.tab-name[\s\S]*display:\s*none/s)
    expect(css).toMatch(/body\.sidebar-collapsed #rail \.rail-name[\s\S]*display:\s*none/s)
    expect(css).toMatch(/body\.sidebar-collapsed #liveBar,[\s\S]*left:\s*72px/s)
    expect(css).toMatch(/body\.sidebar-collapsed #agentSelect option\s*\{[^}]*color:\s*var\(--app-text\)[^}]*font-size:\s*12px/s)
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    expect(compact).toMatch(/\.sidebar-collapse\s*\{[^}]*display:\s*none/s)
  })

  it('reflows queue controls by queue width instead of scrolling them under adjacent panes', () => {
    expect(css).toMatch(/#needsYouList\s*\{[^}]*container:\s*needs-queue\s*\/\s*inline-size/s)
    expect(css).toMatch(/\.tab-header\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s)
    expect(css).toMatch(/\.queue-filter-group,\s*\.queue-tool-group\s*\{[^}]*display:\s*flex/s)
    expect(css).toMatch(/\.header-toggle,\s*\.triage-btn,\s*\.relay-btn\s*\{[^}]*white-space:\s*nowrap/s)
    expect(css).toMatch(/@container needs-queue \(max-width:\s*760px\)[\s\S]*\.tab-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*\}[\s\S]*\.queue-tool-group\s*\{[^}]*grid-template-columns:\s*minmax\(140px,\s*1fr\)\s+auto\s+auto/s)
    expect(css).toMatch(/@container needs-queue \(max-width:\s*440px\)[\s\S]*\.queue-filter-group\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s)
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    expect(compact).not.toMatch(/\.tab-header\s*\{[^}]*overflow-x:\s*auto/s)
  })

  it('gives compact queue titles their own row before wrapping metadata', () => {
    expect(css).toMatch(/\.nrow-primary,\s*\.nrow-meta\s*\{[^}]*display:\s*flex/s)
    expect(css).toMatch(/@container needs-queue \(max-width:\s*620px\)[\s\S]*\.nrow-l1\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*\}[\s\S]*\.nrow-meta\s*\{[^}]*flex-wrap:\s*wrap/s)
  })

  it('keeps archive and reopen actions inside the compact project menu', () => {
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    expect(compact).toMatch(/#projectDisclosure #rail \.rail-close,\s*#projectDisclosure #rail \.rail-reopen\s*\{[^}]*display:\s*inline-grid[^}]*width:\s*24px[^}]*height:\s*24px/s)
    expect(compact).toMatch(/@media \(hover:\s*none\),\s*\(pointer:\s*coarse\),\s*\(any-pointer:\s*coarse\)\s*\{[\s\S]*?#projectDisclosure #rail \.rail-close,\s*#projectDisclosure #rail \.rail-reopen\s*\{[^}]*opacity:\s*\.65[^}]*pointer-events:\s*auto/s)
    expect(compact).not.toMatch(/#rail \.rail-close,\s*#rail \.rail-reopen\s*\{[^}]*display:\s*none/s)
    expect(compact).toMatch(/\.closed-projects-popover\s*\{[^}]*position:\s*absolute[^}]*right:\s*0[^}]*width:\s*min\(360px,\s*calc\(100vw - 24px\)\)[^}]*max-height:\s*min\(420px,\s*calc\(100vh - 180px\)\)[^}]*overflow-y:\s*auto/s)
    expect(compact).toMatch(/\.closed-projects-trigger\s*\{[^}]*width:\s*100%[^}]*position:\s*static/s)
    expect(compact).not.toMatch(/\.rail-close \.rail-action-label\s*\{[^}]*display:\s*inline/s)
  })

  it('contains nested scroll surfaces including the compact project menu', () => {
    expect(css).toMatch(/\.nrow-card,\s*\.closed-projects-popover,\s*\.lb-card,\s*\.live-drawer,\s*\.relay-body,\s*\.mission-paths,\s*\.mission-detail-body,\s*\.setup-body pre\s*\{[^}]*overscroll-behavior:\s*contain/s)
    const desktop = css.slice(0, css.indexOf('@media (max-width: 1279px)'))
    expect(desktop).toMatch(/#rail\s*\{[^}]*overscroll-behavior-y:\s*contain/s)
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    expect(compact).toMatch(/#projectDisclosure #rail\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior-y:\s*contain/s)
  })

  it('keeps the compact page heading clear of filter controls', () => {
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    expect(compact).toMatch(/#topbar\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s)
    expect(compact).toMatch(/\.page-heading\s*\{[^}]*flex:\s*0 1 auto/s)
    expect(compact).toMatch(/\.floating-search\s*\{[^}]*width:\s*min\(520px,\s*100%\)[^}]*flex:\s*1 1 300px/s)
    expect(compact).not.toMatch(/\.topbar-tools\s*\{/)
  })
})
