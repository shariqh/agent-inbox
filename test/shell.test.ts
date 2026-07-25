// test/shell.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

describe('shell markup', () => {
  it('drops the section stack and the outline sidebar', () => {
    expect(html).not.toContain('id="sidebar"')
    expect(html).not.toContain('class="section"')
    expect(html).not.toContain('data-sub=')
  })

  it('has the top bar: brand, status + pause hint, agent select, search, gear', () => {
    expect(html).toContain('id="topbar"')
    expect(html).toContain('class="brand"')
    expect(html).toContain('id="status"')
    expect(html).toContain('id="pauseHint"')
    expect(html).toContain('id="agentSelect"')
    expect(html).toContain('id="search"')
    expect(html).toContain('id="gear"')
  })

  it('has a project rail and the four content tabs in spec order (Live is a footer strip, not a tab — spec §16)', () => {
    expect(html).toContain('id="rail"')
    const tabs = [...html.matchAll(/<button class="tab"[^>]*data-tab="(\w+)"/g)].map((m) => m[1])
    expect(tabs).toEqual(['needsYou', 'boards', 'notes', 'done'])
    expect(html).not.toContain('data-tab="live"')
  })

  it('gives every tab a count slot', () => {
    for (const t of ['needsYou', 'boards', 'notes', 'done']) {
      expect(html, t).toMatch(new RegExp(`data-tab="${t}"[^>]*>[^<]*<span class="tab-count"`))
    }
  })

  it('keeps every render host the viewer writes into', () => {
    for (const host of [
      'id="needsYou"', 'id="boards"', 'id="notes"', 'id="done"', 'id="setup"',
      'id="needsYouList"', 'class="rows"', 'class="groups"',
      'class="boards"', 'class="items"', 'class="setup-body"',
    ]) expect(html, host).toContain(host)
  })

  it('has the always-visible Live footer strip and its collapsed drawer (spec §16)', () => {
    expect(html).toContain('id="liveBar"')
    expect(html).toMatch(/id="liveStrip"[^>]*aria-expanded="false"/)
    expect(html).toMatch(/id="liveStrip"[^>]*aria-controls="liveDrawer"/)
    expect(html).toMatch(/id="liveDrawer"[^>]*hidden/)
    expect(html).toContain('class="live-list"')
    expect(html).toContain('no agents running')
  })

  it('leaves the pieces later tasks build in JS out of the static markup', () => {
    // Task 9 owns the pause hint's text, Task 13 the boards header and the
    // archived fold, Task 18 the responsive layer — none of them reopen this file
    expect(html).not.toContain('id="now"')
    expect(html).not.toContain('id="rowTabs"')
    expect(html).not.toContain('panel-tools')
    expect(html).not.toContain('id="archived"')
    expect(html).not.toContain('archived-fold')
  })
})

describe('shell css', () => {
  it('drops the sidebar, section, now-strip and pill-strip rules', () => {
    expect(css).not.toContain('#sidebar')
    expect(css).not.toContain('#filters')
    expect(css).not.toContain('.section')
    expect(css).not.toContain('#now')
    expect(css).not.toContain('.now-head')
  })

  it('drops the kind-based left stripe', () => {
    expect(css).not.toContain('.item.question')
    expect(css).not.toContain('.item.note')
    expect(css).not.toContain('.item.answered')
    expect(css).not.toContain('border-left-width')
  })

  it('keeps the search box and adds the rail + tabstrip', () => {
    expect(css).toContain('.search-box')
    expect(css).toContain('#rail')
    expect(css).toContain('.tabstrip')
    expect(css).toContain('.panel[hidden]')
  })

  // Task 18 owns every @media rule in this file, appended last so it wins the
  // cascade over the shell (Task 6), boards chrome (Task 13) and focus rules
  // (Task 17) above it. Nothing enforced that beyond a manual grep until fix
  // round 1 — pin it so a future task can't slip a responsive rule in earlier
  // (matching `@media (`, not just the string "@media", so this doesn't trip
  // on the block's own explanatory comment mentioning "@media block").
  it('has exactly one @media rule, appended at EOF', () => {
    const mediaRules = css.match(/@media\s*\([^)]*\)\s*\{/g) ?? []
    expect(mediaRules.length).toBe(1)
    const idx = css.search(/@media\s*\(/)
    expect(idx).toBeGreaterThan(-1)
    const tail = css.slice(idx)
    const lastClose = tail.lastIndexOf('}')
    expect(tail.slice(lastClose + 1).trim(), "content found after the @media block's closing brace").toBe('')
  })
})

describe('shell script', () => {
  it('deletes every sidebar-era render path, so nothing calls a symbol that is gone', () => {
    for (const dead of ['renderSub', 'renderPills', 'renderNow', 'initSections', 'COLLAPSE_KEY', 'renderArchived']) {
      expect(js, `${dead} survives`).not.toContain(dead)
    }
  })

  it('keeps the triage deck reachable now that the Now strip is gone', () => {
    expect(js).toContain('openTriage()')
  })

  it('wires the new shell entry points', () => {
    expect(js).toContain('function renderAgentSelect')
    expect(js).toContain('function showPanel')
    expect(js).toContain('initAgentSelect()')
    expect(js).toContain('initGear()')
    expect(js).toContain('function jumpToCard')
  })
})

// The always-visible footer strip is a single-glance ambient summary — the
// same kind of object as a dock badge — not a triage surface, so rail/agent
// filtering and search must never scope it (§7's filter-blindness invariant,
// generalized). renderLive(live) — the DRAWER's expanded list — stays
// filtered on purpose: it's a list you deliberately open, so scoping it is
// consistent with every other tab. Only the collapsed strip must read global
// activity, or "no agents running" becomes a lie the moment the human filters
// to a project nothing is currently running in. There is no jsdom configured
// in vitest.config.ts, so a real render() invocation isn't exercisable here;
// this pins the SOURCE TEXT instead, the same way the filter-blindness guard
// in test/tabs.test.ts does.
describe('Live footer strip is global, never rail-scoped (spec §16 / §7 generalized)', () => {
  it('calls renderLiveBar with lastData.activity, not the filtered `live` local', () => {
    const line = js.split('\n').find((l) => l.includes('renderLiveBar('))
    expect(line, 'no renderLiveBar( call found in app.js').toBeTruthy()
    expect(line, line).toMatch(/renderLiveBar\(\s*lastData\.activity\b/)
    expect(line, line).not.toMatch(/renderLiveBar\(\s*live\s*\)/)
  })

  it('keeps renderLive on the filtered `live` local — the drawer stays rail-scoped', () => {
    const line = js.split('\n').find((l) => l.includes('renderLive('))
    expect(line, 'no renderLive( call found in app.js').toBeTruthy()
    expect(line, line).toMatch(/renderLive\(\s*live\s*\)/)
  })
})

// load()'s fetch + renderIfIdle() are wrapped in try/catch; a bare `catch {}`
// swallows every exception — including one thrown inside render() itself — and
// silently leaves the page blank with no console signal. That is exactly the
// failure mode that made the "none of the buttons work" incident (0 needs-you
// items, empty panel) hard to diagnose. This pins that the catch binds the
// error and logs it, so nobody can silently reintroduce the bare catch. The
// 'disconnected' status behaviour for a genuine fetch failure must survive.
describe("load()'s catch logs instead of swallowing (incident: silent blank page)", () => {
  it('binds the caught error and passes it to console.error', () => {
    const m = js.match(/async function load\(\)[\s\S]*?\n\}/)
    expect(m, 'load() not found').toBeTruthy()
    const body = m![0]
    expect(body).toMatch(/catch\s*\(\s*\w+\s*\)\s*\{/)
    const caught = body.match(/catch\s*\(\s*(\w+)\s*\)\s*\{([\s\S]*?)\n\s*\}\s*$/)
    expect(caught, 'no catch(err) { … } block found in load()').toBeTruthy()
    const [, errName, catchBody] = caught!
    expect(catchBody).toMatch(new RegExp(`console\\.error\\(\\s*${errName}\\s*\\)`))
    expect(catchBody).toContain("'disconnected'")
  })
})
