import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd())
const html = readFileSync(resolve(root, 'public/index.html'), 'utf8')
const css = readFileSync(resolve(root, 'public/style.css'), 'utf8')
const app = readFileSync(resolve(root, 'public/app.js'), 'utf8')

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

  it('keeps search and keyboard controls in the utility bar and the agent picker in the sidebar', () => {
    const sidebar = html.slice(html.indexOf('<aside class="sidebar-shell">'), html.indexOf('</aside>'))
    const topbar = html.slice(html.indexOf('<header id="topbar">'), html.indexOf('</header>'))
    expect(sidebar).toContain('class="agent-pick"')
    expect(sidebar.indexOf('class="agent-pick"')).toBeGreaterThan(sidebar.indexOf('id="projectDisclosure"'))
    expect(sidebar.indexOf('class="agent-pick"')).toBeLessThan(sidebar.indexOf('id="gear"'))
    expect(topbar).not.toContain('class="agent-pick"')
    expect(topbar).toContain('id="search"')
    expect(topbar).toContain('id="keyboardTools"')
    expect(html).toMatch(/class="floating-search"[^>]*role="search"[\s\S]*id="search"[^>]*aria-keyshortcuts="Meta\+K Control\+K"/)
    expect(css).toMatch(/#topbar\s*\{[^}]*grid-template-columns:\s*minmax\(180px,\s*1fr\)\s+minmax\(220px,\s*400px\)\s+auto/s)
    expect(css).toMatch(/\.floating-search\s*\{[^}]*position:\s*relative[^}]*width:\s*100%/s)
    expect(css).toMatch(/\.search-results\s*\{[^}]*top:\s*calc\(100% \+ 8px\)[^}]*bottom:\s*auto/s)
    expect(css).toMatch(/\.agent-pick\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*border-top:\s*1px solid var\(--app-border\)/s)
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

  it('lets inline card regions grow with the page instead of trapping wheel scrolling', () => {
    // jsdom cannot evaluate these queries. The release must be inside both the
    // compact media layer and the exact complement of the phone card container.
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    const inline = compact.match(/@container needs-queue \(width > 440px\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/s)?.[1] ?? ''
    expect(compact).toMatch(/#needsYouList \.nrow-card\s*\{[^}]*position:\s*static[^}]*overflow:\s*visible/s)
    expect(inline).toMatch(/\.nrow-card\s*\{[^}]*overscroll-behavior:\s*auto/s)
    expect(inline).toMatch(/\.nrow-card-head,\s*\.nrow-card-scroll,\s*\.nrow-card-compose\s*\{[^}]*flex:\s*0 0 auto[^}]*max-height:\s*none[^}]*overflow:\s*visible[^}]*overscroll-behavior:\s*auto/s)
  })

  it('keeps fixed desktop and phone card scrolling bounded and contained', () => {
    const desktop = css.slice(0, css.indexOf('@media (max-width: 1279px)'))
    expect(desktop).toMatch(/\.nrow-card-head\s*\{[^}]*max-height:\s*40%[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s)
    expect(desktop).toMatch(/\.nrow-card-scroll\s*\{[^}]*flex:\s*1 1 auto[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s)
    expect(desktop).toMatch(/\.nrow-card-compose\s*\{[^}]*max-height:\s*min\(50%,\s*360px\)[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s)
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    const phone = compact.slice(compact.indexOf('@container needs-queue (max-width: 440px)'))
    expect(phone).toMatch(/#needsYouList \.nrow-card\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/s)
    expect(phone).toMatch(/\.nrow-card-scroll\s*\{[^}]*min-height:\s*0[^}]*flex:\s*1 1 auto[^}]*overflow-y:\s*auto/s)
    expect(phone).toMatch(/\.nrow-card-compose\s*\{[^}]*max-height:\s*min\(42dvh,\s*320px\)[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s)
    expect(phone).not.toMatch(/overscroll-behavior(?:-y)?:\s*auto/)
  })

  it('keeps code blocks horizontally scrollable without trapping vertical chaining', () => {
    const code = css.match(/\.structured-code pre\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(code).toMatch(/overflow:\s*auto/)
    expect(code).not.toMatch(/overscroll-behavior(?:-y)?:\s*(?:contain|none)/)
  })

  it('wraps action headlines and option labels without clipping warnings or crowding touch controls', () => {
    expect(css).toMatch(/\.nrow-title\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s)
    expect(css).toMatch(/\.opt-pill\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s)
    expect(css).toMatch(/\.card-tldr,\s*\.card-impact,\s*\.card-after\s*\{[^}]*padding:\s*0[^}]*border:\s*0[^}]*background:\s*transparent/s)
    expect(css).toMatch(/\.nrow-card-head\s*\{[^}]*display:\s*flex/s)
    expect(css).toMatch(/\.opt-pill,\s*\.reply-row button,\s*\.disposition-btn\s*\{[^}]*min-height:\s*44px/s)
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    expect(compact).toMatch(/\.nrow-card-compose \.options\.comparing\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s)
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

  // #103 slice 2: fixed layout sizes columns from the first row unless <col>s say
  // otherwise, and a plan's first row may be a full-width "Part of #N" header.
  it('sizes compact plan columns from a colgroup, never from the first row', () => {
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    expect(app).toContain('<colgroup><col class="col-num"><col class="col-glyph"><col class="col-label"><col class="col-4"><col class="col-5"></colgroup>')
    expect(compact).toMatch(/\.board-table\.matrix col\.col-num\s*\{[^}]*width:\s*24px/s)
    expect(compact).toMatch(/\.board-table\.matrix col\.col-glyph\s*\{[^}]*width:\s*30px/s)
    expect(compact).toMatch(/\.board-table\.matrix col\.col-4\s*\{[^}]*width:\s*72px/s)
    expect(compact).toMatch(/\.board-table\.matrix col\.col-5\s*\{[^}]*width:\s*0/s)
    // the wide layout sizes columns from its cells, as before
    expect(css.slice(0, css.indexOf('@media (max-width: 1279px)'))).not.toMatch(/col\.col-/)
  })

  it('composes compact navigation as one masthead with a single project menu', () => {
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    const masthead = compact.slice(0, compact.indexOf('@container compact-masthead'))
    expect(html).toContain('id="projectDisclosureToggle"')
    expect(masthead).toMatch(/\.app-shell\s*\{[^}]*container:\s*compact-masthead\s*\/\s*inline-size/s)
    expect(masthead).not.toMatch(/\.sidebar-shell\s*\{[^}]*container:\s*compact-masthead/s)
    // #454: two rows: the tabs alone on the first (scrolling in their own cell), and the
    // selectors, the Sessions chip and Settings on the second, so nothing lands over a tab
    expect(compact).toMatch(/\.sidebar-shell\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) minmax\(130px,\s*180px\) auto auto[^}]*grid-template-rows:\s*auto auto/s)
    expect(compact).toMatch(/#tabs\s*\{[^}]*grid-column:\s*2 \/ -1[^}]*grid-row:\s*1[^}]*width:\s*max-content[^}]*overflow-x:\s*auto/s)
    expect(compact).toMatch(/\.sessions-indicator\s*\{[^}]*grid-column:\s*4[^}]*grid-row:\s*2[^}]*border-radius:\s*999px/s)
    expect(compact).toMatch(/\.gear\s*\{[^}]*grid-column:\s*5[^}]*grid-row:\s*2/s)
    // the chip keeps its G L tile after the count; the word goes
    expect(compact).toMatch(/\.sessions-indicator \.si-k\[data-shortcut\]\s*\{[^}]*font-size:\s*0/s)
    expect(masthead).toMatch(/\.sidebar-section-label\s*\{[^}]*display:\s*none/s)
    expect(masthead).toMatch(/\.sidebar-shell \.project-disclosure\s*\{[^}]*position:\s*relative[^}]*display:\s*block[^}]*grid-column:\s*1 \/ 3[^}]*grid-row:\s*2/s)
    expect(masthead).toMatch(/\.sidebar-shell \.agent-pick\s*\{[^}]*grid-column:\s*3[^}]*grid-row:\s*2/s)
    expect(masthead).toMatch(/\.sidebar-shell \.project-disclosure-toggle\s*\{[^}]*display:\s*flex/s)
    expect(masthead).toMatch(/#projectDisclosure #rail\s*\{[^}]*position:\s*absolute[^}]*display:\s*none[^}]*flex-direction:\s*column[^}]*overflow-y:\s*auto[^}]*overscroll-behavior-y:\s*contain/s)
    expect(masthead).toMatch(/#projectDisclosure\[data-open="true"\] #rail\s*\{[^}]*display:\s*flex/s)
    expect(masthead).not.toMatch(/#rail\s*\{[^}]*overflow-x:\s*auto/s)
    expect(compact).toMatch(/#projectDisclosure #rail \.rail-name\s*\{[^}]*text-overflow:\s*ellipsis/s)
    // under 620px the chip and Settings share the brand's row
    expect(compact).toMatch(/@container compact-masthead \(max-width:\s*620px\)[\s\S]*\.sessions-indicator\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1/s)
    expect(compact).toMatch(/@container compact-masthead \(max-width:\s*620px\)[\s\S]*#tabs\s*\{[^}]*display:\s*flex[^}]*grid-column:\s*1\s*\/\s*-1[^}]*grid-row:\s*2[^}]*overflow-x:\s*auto/s)
    expect(compact).toMatch(/@container compact-masthead \(max-width:\s*620px\)[\s\S]*#tabs \.tab-count\s*\{[^}]*display:\s*inline-block/s)
    expect(compact).toMatch(/@container compact-masthead \(max-width:\s*620px\)[\s\S]*\.sidebar-shell \.project-disclosure\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*3[\s\S]*\.sidebar-shell \.agent-pick\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*3/s)
    expect(compact).toMatch(/@container compact-masthead \(max-width:\s*440px\)[\s\S]*\.sidebar-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto auto[^}]*grid-template-rows:\s*auto auto auto[\s\S]*\.sidebar-shell \.project-disclosure\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*3[\s\S]*\.sidebar-shell \.agent-pick\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*3/s)
  })

  it('collapses the wide sidebar into an icon rail without changing compact mastheads', () => {
    expect(html).toMatch(/id="sidebarCollapse"[^>]*aria-expanded="true"/)
    expect(css).toMatch(/body\.sidebar-collapsed \.sidebar-shell\s*\{[^}]*padding:/s)
    expect(css).toMatch(/body\.sidebar-collapsed \.tab-name[\s\S]*display:\s*none/s)
    expect(css).toMatch(/body\.sidebar-collapsed #rail \.rail-name[\s\S]*display:\s*none/s)
    // #454: the Sessions line shrinks to its dot, where the Live strip once moved over
    expect(css).toMatch(/body\.sidebar-collapsed \.sessions-indicator\s*\{[^}]*grid-template-columns:\s*10px/s)
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

  it('wraps a wide row\'s metadata to its own line instead of squeezing the title (#590)', () => {
    // above the 620px stack: the title keeps 18rem and the metadata may shrink, wrap and drop below it
    expect(css).toMatch(/\n\.nrow-l1\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap/s)
    expect(css).toMatch(/\n\.nrow-primary\s*\{\s*flex:\s*1 1 18rem;\s*\}/)
    expect(css).toMatch(/\n\.nrow-meta\s*\{[^}]*flex:\s*0 1 auto;[^}]*flex-wrap:\s*wrap;[^}]*margin-left:\s*auto/s)
    // the old rule kept the metadata at full width whatever the title had left
    expect(css).not.toMatch(/\n\.nrow-meta\s*\{\s*flex:\s*0 0 auto;/)
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
    expect(css).toMatch(/\.nrow-card,\s*\.closed-projects-popover,\s*\.lb-card,\s*\.relay-body,\s*\.mission-paths,\s*\.mission-detail-body,\s*\.setup-body pre\s*\{[^}]*overscroll-behavior:\s*contain/s)
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

// #307: jsdom never matches the compact @media block, so the session panel's
// placement is pinned on the source.
describe('the session panel placement (#307, #454)', () => {
  const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
  const desktop = css.slice(0, css.indexOf('@media (max-width: 1279px)'))
  const rule = (sheet: string) => sheet.match(/(?:^|\n)\s*\.dash-focus\s*\{([^}]*)\}/)?.[1] ?? ''

  // dashboard lanes design §3.6 (PR 5): beside the lanes, never a sheet over them
  it('sits beside the lanes in a split on a desktop, mounted in the split where no lens can hide it', () => {
    expect(app).toMatch(/split\.append\(agentsHome\.element\(\), dashFocusEl\(\)\)/)
    // closed, the split is no box, so the lanes keep the full width
    expect(desktop).toMatch(/\.dash-split \{ display: contents; \}/)
    // the sheet's containing block is gone with the sheet
    expect(desktop).not.toMatch(/\.dashboard-grid\s*\{\s*position:\s*relative;\s*\}/)
    const panel = rule(desktop)
    expect(panel).toMatch(/position: sticky;/)
    expect(panel).toMatch(/top: 116px;/)
    expect(panel).toMatch(/max-height: calc\(100vh - 116px - var\(--sp-4\)\);/)
    expect(panel).not.toMatch(/position:\s*(absolute|fixed)|z-index|box-shadow|width:/)
    expect(desktop).toMatch(/\.dash-split\.open \{ display: grid; grid-column: 1 \/ -1; grid-template-columns: minmax\(0, 1fr\) clamp\(360px, 34%, 460px\); column-gap: var\(--sp-4\); align-items: start; \}/)
    expect(desktop).toMatch(/\.dash-split\.open > \.agents-home \{ grid-column: 1; grid-row: 1; \}/)
    expect(desktop).toMatch(/\.dash-split\.open > \.dash-focus \{ grid-column: 2; grid-row: 1; \}/)
    // held inline by focus across a resize, it lays out as the narrow panel, not as a card cell
    expect(desktop).toMatch(/:is\(\.ah-cards, \.qt-rows\) > \.dash-focus \{ position: static; grid-column: 1 \/ -1; max-height: none; \}/)
    // no new motion: the one-shot entrance only
    expect(panel).toMatch(/animation: dash-focus-in var\(--motion-moderate\) var\(--motion-ease-out\) 1;/)
    expect(css).not.toMatch(/\n[^{}\n]*\.dash-split[^{}\n]*\{[^}]*(transition|animation)/)
  })

  it('joins the flow after the list under 1280px, never over the masthead', () => {
    const narrow = rule(compact)
    expect(narrow).toMatch(/position:\s*static;/)
    expect(narrow).toMatch(/max-height:\s*none;/)
    expect(narrow).not.toMatch(/z-index/)
    // the split never turns on there (app.js syncSplit), so no compact rule needs it
    expect(compact.slice(0, compact.indexOf('\n}'))).not.toMatch(/\.dash-split/)
  })
})

// The Working lane's cards (#454, dashboard lanes design §3.3): jsdom cannot lay
// out its card grid, so its layout promise is pinned in the source: three at
// 1440px, two at 1280px, one below 900px.
describe('the Working lane’s card grid (#454)', () => {
  it('never needs a card wider than the screen', () => {
    expect(css).toMatch(/\.ah-cards \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(min\(340px, 100%\), 1fr\)\)/)
    // #454 A.3: two columns under 1280px and one in a narrow desk, where the panel opens inline under its card
    expect(css.slice(css.indexOf('@media (max-width: 1279px)'))).toMatch(/\.ah-cards \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}\s*@container operations-desk \(max-width: 900px\) \{\s*\.ah-cards \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  })
})

// Dashboard lanes design §3.3, §3.4, §4: the Working and Quiet lanes take the
// tokens; jsdom cannot lay out the Quiet table, so its promises are pinned here.
describe('the Working and Quiet lanes (dashboard lanes PR 4)', () => {
  const OURS = /(^|[\s,>])\.(agents-home|ah-lane[\w-]*|working-lane|quiet-lane|qt-[\w-]+|ah-group-head|ah-group-count)(?![\w-])/
  const all = [...css.matchAll(/(?:^|\n)([^{}@\n][^{}\n]*)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }))
  const rules = all.filter((r) => OURS.test(r.selector))
  const body = (selector: string, sheet = all) => sheet.find((r) => r.selector === selector)?.body ?? ''
  const block = (start: string) => {
    const from = css.slice(css.indexOf(start))
    return from.slice(0, from.indexOf('\n}'))
  }

  it('take the tokens for every font size, gap, margin and padding', () => {
    expect(rules.length).toBeGreaterThan(15)
    for (const { selector, body: decls } of rules) {
      for (const [, prop, value] of decls.matchAll(/(?<![\w-])(font-size|gap|row-gap|column-gap|margin[\w-]*|padding[\w-]*):\s*([^;]+);/g)) {
        for (const part of value!.trim().split(/\s+/)) {
          expect(part, `${selector} ${prop}`).toMatch(/^(0|auto|var\(--(fs-[\w-]+|sp-\d|lane-gap)\))$/)
        }
      }
    }
    expect(body('.agents-home')).toMatch(/row-gap: var\(--lane-gap\);/)
    expect(body('.ah-group-head')).toMatch(/font-size: var\(--fs-title\);/)
    expect(body('.ah-group-head')).not.toMatch(/uppercase/)
    expect(body('.working-lane .sc-doing')).toMatch(/font-size: var\(--fs-lead\);/)
    expect(body('.working-lane .sc-state')).toMatch(/display: none;/)
    // the hidden label would leave its "·" in front of the agent
    expect(body('.working-lane .sc-chips > :first-child::before')).toMatch(/content: none;/)
    // a long recency wraps under the agent and branch (it squeezed the branch to an ellipsis in a
    // narrow card), and a wrapped line does not begin with the "·"
    expect(body('.working-lane .sc-top')).toMatch(/flex-wrap: wrap;/)
    expect(body('.working-lane .sc-when::before')).toMatch(/content: none;/)
  })

  it('line the Quiet table up with one template of zero-minimum tracks, so no cell widens the page', () => {
    const template = body('.qt-head, .qt-row').match(/grid-template-columns: ([^;]+);/)?.[1] ?? ''
    const tracks = template.match(/minmax\([^)]*\)/g) ?? []
    expect(tracks).toHaveLength(6)
    for (const track of tracks) expect(track).toMatch(/^minmax\(0, \d+fr\)$/)
    expect(css).not.toMatch(/\.qt-[\w-]+[^{}]*\{[^}]*(subgrid|max-content)/)
    // a row's cells are one line each; the card's clamp and its "·" before the time are not a cell's
    expect(body('.qt-row .sc-doing')).toMatch(/white-space: nowrap;/)
    expect(body('.qt-row .sc-when::before')).toMatch(/content: none;/)
    expect(body('.qt-act .sc-actions')).toMatch(/flex-wrap: wrap;/)
    // the card's `flex: none` is overridden, or the group holds one line's width and spills over Since
    expect(body('.qt-act .sc-actions')).toMatch(/flex: 0 1 auto; min-width: 0;/)
    expect(body('.qt-act .sc-action')).toMatch(/flex: 0 1 auto; min-width: 0; white-space: normal;/)
  })

  it('give a Quiet row the card’s tones and its hollow dot for an idle state', () => {
    expect(css).toMatch(/:is\(\.sc, \.qt-row\)\.tone-parked, :is\(\.sc, \.qt-row\)\.tone-terminal \{ --sc-tone: var\(--app-warning\); \}/)
    expect(css).toMatch(/:is\(\.sc, \.qt-row\)\.tone-failed, :is\(\.sc, \.qt-row\)\.tone-lost \{ --sc-tone: var\(--app-danger\); \}/)
    expect(css).toMatch(/:is\(\.sc, \.qt-row\)\.tone-idle \.sc-dot, :is\(\.sc, \.qt-row\)\.tone-dormant \.sc-dot, :is\(\.sc, \.qt-row\)\.tone-ended \.sc-dot \{ border: 1\.5px solid/)
  })

  it('put a Quiet row on two lines below 900px, on its own template, with no header', () => {
    // keyed on the lanes' own width (§3.6): narrower than the Dashboard beside an open session panel
    expect(body('.agents-home')).toMatch(/container: dash-lanes \/ inline-size;/)
    expect(block('@container operations-desk (max-width: 900px) {')).not.toMatch(/\.qt-/)
    const narrow = block('@container dash-lanes (max-width: 900px) {')
    const sheet = [...narrow.matchAll(/\n\s*([^{}\n]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }))
    expect(body('.qt-head', sheet)).toMatch(/display: none;/)
    const row = body('.qt-row', sheet)
    expect(row).toMatch(/grid-template-areas: "state session since" "branch caption act";/)
    // every track bounded: an auto third track took Since's and the actions' one-line width first
    expect(row).toMatch(/grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1\.5fr\) minmax\(0, 1fr\);/)
    expect(row).not.toMatch(/auto/)
    for (const [cell, area] of [['qt-state', 'state'], ['qt-session', 'session'], ['qt-since', 'since'], ['qt-branch', 'branch'], ['qt-caption', 'caption'], ['qt-act', 'act']]) {
      expect(body(`.${cell}`, sheet), cell).toMatch(new RegExp(`grid-area: ${area};`))
    }
  })

  it('open the session panel inline in a lane’s list below 1280px without covering the card above', () => {
    const compact = css.slice(css.indexOf('@media (max-width: 1279px)'))
    expect(compact).toMatch(/\.ah-cards > \.dash-focus \{ margin-top: 0; \}/)
    expect(compact).toMatch(/\.qt-rows > \.dash-focus \{ margin: var\(--sp-2\) 0; \}/)
  })

  it('leave no filter, group-by or count beside a heading', () => {
    expect(css).not.toMatch(/\.ah-filter|\.ah-group-by|\.ah-count|\.ah-none|\.ah-show-all|ah-is-empty|\.ah-head\b/)
  })
})

// Dashboard lanes design §3.1, §3.2, §4: the page head's chips and the Needs
// you lane take the type and spacing tokens, never a literal size or gap.
describe('the Needs you lane and the lane chips (dashboard lanes PR 3)', () => {
  // every top-level rule whose selector names one of the new parts
  const OURS = /(^|[\s,>])\.(dash-head|dash-chip[\w-]*|dash-chips|dash-head-actions|needs-you-lane|ny-[\w-]+|sc-asking)(?![\w-])/
  const rules = [...css.matchAll(/(?:^|\n)([^{}@\n][^{}\n]*)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1]!.trim(), body: m[2]! }))
    .filter((r) => OURS.test(r.selector))
  const body = (selector: string) => rules.find((r) => r.selector === selector)?.body ?? ''

  it('take the tokens for every font size, gap, margin and padding', () => {
    expect(rules.length).toBeGreaterThan(10)
    for (const { selector, body: decls } of rules) {
      for (const [, prop, value] of decls.matchAll(/(?<![\w-])(font-size|gap|row-gap|column-gap|margin[\w-]*|padding[\w-]*):\s*([^;]+);/g)) {
        for (const part of value!.trim().split(/\s+/)) {
          expect(part, `${selector} ${prop}`).toMatch(/^(0|auto|var\(--(fs-[\w-]+|sp-\d|lane-gap)\))$/)
        }
      }
    }
    expect(body('.ny-title')).toMatch(/font-size: var\(--fs-title\);/)
    expect(body('.needs-you-lane')).toMatch(/margin-top: var\(--lane-gap\);/)
    expect(body('.ny-cards')).toMatch(/gap: var\(--sp-3\);/)
    expect(body('.ny-card')).toMatch(/padding: var\(--sp-3\) var\(--sp-4\);/)
  })

  it('keep a Needs you card\'s branch readable: the session note takes its own line', () => {
    // held on the meta line, "session ended" squeezed a short branch down to an ellipsis
    expect(body('.ny-meta')).toMatch(/flex-wrap: wrap;/)
    const note = body('.ny-session')
    for (const rule of [/order: 2;/, /flex: 0 0 100%;/]) expect(note).toMatch(rule)
    expect(body('.ny-meta > .ny-session::before')).toMatch(/content: none;/)
    // a zero basis keeps a long branch, and the age after it, on the first line
    const branch = body('.ny-branch')
    for (const rule of [/flex: 1 1 0;/, /max-width: max-content;/, /min-width: 0;/, /text-overflow: ellipsis;/]) expect(branch).toMatch(rule)
    expect(body('.ny-draft')).toMatch(/order: 1;/)
  })

  it('wrap Later and Review queue under the lane title below 620px, and leave no Now strip', () => {
    const narrow = css.slice(css.indexOf('@container operations-desk (max-width: 620px) {'))
    expect(narrow.slice(0, narrow.indexOf('\n}'))).toMatch(/\.ny-head > h2 \{ flex-basis: 100%; \}/)
    expect(css).not.toMatch(/\.dash-now|\.dashboard-value|\.sc-ask\b|\.sc-ask-|sc-ask-only|tone-ask|\.ah-later|\.ah-review/)
  })
})
