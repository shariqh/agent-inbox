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

  it('has a project rail and the five content tabs in spec order', () => {
    expect(html).toContain('id="rail"')
    const tabs = [...html.matchAll(/<button class="tab"[^>]*data-tab="(\w+)"/g)].map((m) => m[1])
    expect(tabs).toEqual(['needsYou', 'boards', 'live', 'notes', 'done'])
  })

  it('gives Live a presence dot and every other tab a count slot', () => {
    expect(html).toMatch(/data-tab="live"[^>]*>[^<]*<span class="tab-dot"/)
    for (const t of ['needsYou', 'boards', 'notes', 'done']) {
      expect(html, t).toMatch(new RegExp(`data-tab="${t}"[^>]*>[^<]*<span class="tab-count"`))
    }
  })

  it('keeps every render host the viewer writes into', () => {
    for (const host of [
      'id="needsYou"', 'id="boards"', 'id="live"', 'id="notes"', 'id="done"', 'id="setup"',
      'id="needsYouList"', 'class="rows"', 'class="live-list"', 'class="groups"',
      'class="boards"', 'class="items"', 'class="setup-body"',
    ]) expect(html, host).toContain(host)
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
})

describe('shell script', () => {
  it('deletes every sidebar-era render path, so nothing calls a symbol that is gone', () => {
    for (const dead of ['renderSub', 'renderPills', 'renderNow', 'initSections', 'COLLAPSE_KEY', 'renderArchived']) {
      expect(js, `${dead} survives`).not.toContain(dead)
    }
  })

  it('keeps the triage deck reachable now that the Now strip is gone', () => {
    expect(js).toContain("e.key === 't'")
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
