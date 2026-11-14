// Type and spacing tokens (design: dashboard lanes, section 4) and their first
// use, the Dashboard's region headers and gaps. jsdom returns var() unresolved
// and never matches a container query (docs/architecture/testing.md), so this
// is pinned on the stylesheet source.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd())
const css = readFileSync(resolve(root, 'public/style.css'), 'utf8')
const design = readFileSync(resolve(root, 'DESIGN.md'), 'utf8')
const main = readFileSync(resolve(root, 'electron/main.cjs'), 'utf8')

// The body of the first rule whose selector is exactly `selector`.
const ruleBody = (selector: string, from = 0): string => {
  const at = css.indexOf(`\n${selector} {`, from)
  if (at < 0) return ''
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
}
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')))

const TOKENS: Record<string, string> = {
  '--fs-meta': '12px',
  '--fs-body': '13px',
  '--fs-lead': '15px',
  '--fs-title': '17px',
  '--fs-lane': '28px',
  '--sp-1': '4px',
  '--sp-2': '8px',
  '--sp-3': '12px',
  '--sp-4': '16px',
  '--sp-5': '20px',
  '--sp-6': '28px',
  '--sp-7': '56px',
  '--lane-gap': '56px',
}

describe('type and spacing tokens', () => {
  it('are declared in :root with the design values, beside the existing --gap', () => {
    for (const [name, value] of Object.entries(TOKENS)) {
      expect(rootBlock, name).toMatch(new RegExp(`${name}:\\s*${value};`))
    }
    expect(rootBlock).toMatch(/--gap:\s*16px;/)
  })

  it('are documented in DESIGN.md with the rule that new CSS uses tokens', () => {
    // --sp-1 to --sp-7 share one row, written as a range
    for (const name of Object.keys(TOKENS).filter((n) => !/^--sp-[2-6]$/.test(n))) expect(design, name).toContain(`\`${name}\``)
    expect(design).toMatch(/tokens, not literal sizes/i)
  })
})

describe('the Dashboard region headers and gaps', () => {
  it('draw every region header at --fs-lane, weight 650', () => {
    const h2 = ruleBody('.dashboard-card h2')
    expect(h2).toMatch(/font-size:\s*var\(--fs-lane\);/)
    expect(h2).toMatch(/font-weight:\s*650;/)
  })

  it('go compact under 900px: 24px headers and a 40px lane gap', () => {
    const compact = css.slice(css.indexOf('@container operations-desk (max-width: 900px) {'))
    expect(compact.slice(0, compact.indexOf('\n}'))).toMatch(/\.dashboard-grid \{ --fs-lane: 24px; --lane-gap: 40px; \}/)
  })

  it('space regions by --lane-gap and a header from its content by --sp-5', () => {
    const grid = ruleBody('.dashboard-grid', css.indexOf('\n.dashboard-grid {\n  display: grid'))
    expect(grid).toMatch(/row-gap:\s*var\(--lane-gap\);/)
    expect(grid).toMatch(/margin-top:\s*var\(--lane-gap\);/)
    expect(ruleBody('.dashboard-card-head')).toMatch(/margin-bottom:\s*var\(--sp-5\);/)
    expect(ruleBody('.dashboard-card')).toMatch(/padding:\s*var\(--sp-5\);/)
  })

  it('leave no 14px or 17px literal in the Dashboard card rules', () => {
    for (const selector of ['.dashboard-card', '.dashboard-card-head', '.dashboard-card h2', '.dash-ribbon']) {
      expect(ruleBody(selector), selector).not.toMatch(/\b1[47]px\b/)
    }
  })
})

describe('the desktop window default', () => {
  it('comes from the work-area helper, not a literal below the 1280px breakpoint', () => {
    expect(main).toContain("require('./window-size.cjs')")
    expect(main).toMatch(/defaultWindowSize\(screen\.getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)\.workAreaSize\)/)
    expect(main).not.toMatch(/width:\s*1100/)
  })
})
