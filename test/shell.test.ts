// test/shell.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const sourceFn = (name: string, endMarker: string): string => {
  const start = js.indexOf(name)
  expect(start, `${name} not found in public/app.js`).toBeGreaterThan(-1)
  const end = js.indexOf(endMarker, start)
  expect(end, `end marker ${endMarker} not found after ${name}`).toBeGreaterThan(-1)
  return js.slice(start, end)
}

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

  it('dims the app chrome behind Settings without motion', () => {
    expect(js).toContain("document.body.classList.toggle('settings-open', id === 'setup')")
    expect(css).toContain('body.settings-open #rail')
    expect(css).not.toMatch(/settings-open[^}]*transition/)
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
    expect(html).toMatch(/id="livePin"[^>]*aria-pressed="false"/)
    expect(html).toContain('Pin Live sessions open')
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
// to a project nothing is currently running in. This pins the SOURCE TEXT —
// which ARGUMENT the call site passes — because that is the actual invariant
// and no runtime assertion can see it. The behavioural half now runs for real
// in test/dom/boot.test.ts ("a rail filter narrows the LIST, never the GLOBAL
// signal"); keep both. (There IS a jsdom harness since test/dom/harness.ts —
// the older "no jsdom in this repo" note here was correct at the time and is
// no longer true.)
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

// ── issue #32: close / reopen a project ──────────────────────────────────────
// SOURCE-TEXT pins for the properties no runtime assertion can see: WHICH data
// each call site is handed. The behavioural half — clicking ×, peeking, the
// banner, the implicit reopen — runs for real against jsdom in
// test/dom/closed-projects.test.ts. Keep both; they cover different things.
//
// The body-slicing helper is the established idiom from
// test/critical-fixes.test.ts. Do NOT write `attentionCount\([^)]*lastData\.closed`:
// `[^)]*` cannot cross the `)` that closes `allItems(lastData.g)`, so it can
// never match correct code.
describe('closed projects (issue #32)', () => {
  const fn = (name: string, endMarker: string) => {
    const start = js.indexOf(name)
    expect(start, `${name} not found in public/app.js`).toBeGreaterThan(-1)
    const end = js.indexOf(endMarker, start)
    expect(end, `end marker ${endMarker} not found after ${name}`).toBeGreaterThan(-1)
    return js.slice(start, end)
  }

  it('applyBadge computes the title count with the closed set', () => {
    expect(fn('function applyBadge()', '\n// The rendered Needs-you row'))
      .toMatch(/attentionCount\([\s\S]*?lastData\.closed/)
  })

  it('the triage deck is built from the same suppressed set (tenet 3 names the deck)', () => {
    expect(fn('function buildDeck()', '\n// resolve a deck entry'))
      .toMatch(/attentionEntries\([\s\S]*?lastData\.closed/)
  })

  it("the Needs-you tab count reads it too, on one line so tabs.test.ts's line pin still holds", () => {
    const line = js.split('\n').find((l) => l.includes('globalAttention:'))
    expect(line, line).toMatch(/lastData\.closed/)
  })

  it('load() fetches the closed set defensively — a missing route must not blank the page', () => {
    const body = fn('async function load()', '\n// fix round 1 (hardening)')
    expect(body).toContain('/api/projects/closed')
    // an older viewer answers 404 with HTML; a bare .json() would throw into
    // load()'s catch and turn the whole page 'disconnected'
    const fetchLine = body.split('\n').find((l) => l.includes('/api/projects/closed'))!
    expect(fetchLine).toMatch(/\.catch\(/)
    expect(fetchLine).toMatch(/r\.ok/)
    expect(body).toMatch(/lastData = \{[^}]*closed/)
  })

  it('projMatches is assigned to the MODULE binding, never re-declared inside render()', () => {
    // a function-scoped `const projMatches` is legal JS that silently shadows the
    // module binding, leaving renderRail reading an empty Map forever — and the
    // fold's auto-open-on-search-hit rule dead on arrival
    expect(js).toMatch(/^let projMatches = new Map\(\)/m)
    expect(js, 'render() re-declares projMatches and shadows the module binding')
      .not.toMatch(/const projMatches\s*=/)
  })

  it('the ambient frame computes projMatches BEFORE renderRail, and withoutClosed AFTER it', () => {
    const body = fn('function paintAmbient()', '\nfunction paintEditableSurfaces(')
    expect(body.indexOf('projMatches =')).toBeLessThan(body.indexOf('renderRail()'))
    // renderRail is what reconciles a stale projectFilter, and withoutClosed
    // reads projectFilter to decide whether this is a peek
    expect(body.indexOf('renderRail()')).toBeLessThan(body.indexOf('withoutClosed(lastData)'))
    // …but setRailMatch must stay AFTER renderRail: renderRail does
    // host.innerHTML = '', so painting match counts first would wipe them
    expect(body.indexOf('renderRail()')).toBeLessThan(body.indexOf('setRailMatch('))
  })

  it('projectMatchCounts still reads the global lastData, so a match behind a closed project stays discoverable', () => {
    const body = fn('function paintAmbient()', '\nfunction paintEditableSurfaces(')
    expect(body).toMatch(/projMatches = projectMatchCounts\(lastData,/)
  })

  it('the Live footer strip and the drawer stay global — presence is not attention (§16)', () => {
    const body = fn('function paintAmbient()', '\nfunction paintEditableSurfaces(')
    expect(body).toMatch(/renderLiveBar\(\s*lastData\.activity\b/)
    // pillLive (the drawer's source) is filtered by project/agent only, never by closure
    expect(body).toMatch(/const pillLive = \(lastData\.activity/)
    expect(body, 'the Live drawer must not be closure-scoped').not.toMatch(/pillLive[\s\S]{0,120}closedSet\(/)
  })

  it('renderRail splits open from closed and builds the fold from the pure rail helpers', () => {
    const body = fn('function renderRail()', '\n// the top bar')
    for (const call of ['splitClosed(', 'closedRailEntries(', 'suppressedTotal(']) {
      expect(body, call).toContain(call)
    }
    expect(js).toMatch(/import\s*\{[^}]*closedFoldLabel[^}]*\}\s*from\s*'\/rail\.js'/)
    expect(js).toContain('closed-fold')
    expect(js).toContain('rail-close')
    expect(js).toContain('rail-reopen')
  })

  it('the rail signature includes the closed rows and the fold state, or the rail goes stale', () => {
    const body = fn('function renderRail()', '\n// the top bar')
    const sig = body.split('\n').find((l) => l.includes('const sig = JSON.stringify(['))!
    expect(sig).toContain('closedEntries')
    expect(sig).toContain('foldOpen')
  })

  it('does not synchronize derived tablet fold state before the rail decides to rebuild', () => {
    const body = fn('function renderRail()', '\n// the top bar')
    expect(body.indexOf('if (host.dataset.sig === sig) return'))
      .toBeLessThan(body.indexOf('if (tablet) closedFoldOpen = foldOpen'))
  })

  it('derives the phone/tablet boundary from the compact masthead content box', () => {
    expect(js).toContain("document.querySelector('.sidebar-shell')")
    expect(js).toMatch(/clientWidth\s*\|\|\s*window\.innerWidth/)
    expect(js).toMatch(/paddingLeft/)
    expect(js).toMatch(/paddingRight/)
  })

  it('tracks phone, tablet, and desktop project navigation as distinct modes', () => {
    const mode = fn('function projectNavigationMode()', '\nfunction higherPriorityEscapeSurfaceOpen')
    expect(mode).toContain("return 'desktop'")
    expect(mode).toContain("? 'tablet' : 'phone'")
    const disclosure = fn('function initProjectDisclosure()', '\nfunction railActionEl(')
    expect(disclosure).toContain('projectMode = projectNavigationMode()')
    expect(disclosure).toContain('projectMode = next')
    expect(disclosure).toContain('const focusState = projectFocusState(document.activeElement)')
    expect(disclosure).toContain('setClosedProjectsOpen(false)')
    expect(disclosure).toContain('restoreProjectFocus(focusState)')
    expect(disclosure).toMatch(/matchMedia\(`\(max-width: \$\{NARROW_MAX\}px\)`\)/)
    const fold = fn('function closedFoldEl(', '\nfunction focusProjectControl(')
    expect(fold).toMatch(/if \(!fold\.isConnected \|\| tabletProjectsMode\(\)\) return/)
  })

  it('keeps the type-to-narrow filter escapable — railQuery is cleared whenever the input is not rendered', () => {
    // closing projects can drop the open count under RAIL_FILTER_THRESHOLD,
    // removing the input while a non-empty query still hides most of the rail
    const body = fn('function renderRail()', '\n// the top bar')
    expect(body).toMatch(/const withFilter = shouldShowRailFilter\(open\)/)
    expect(body).toMatch(/if \(!withFilter\) railQuery = ''/)
  })

  it('keeps the caret restore and the sig short-circuit the rewrite could have dropped', () => {
    const body = fn('function renderRail()', '\n// the top bar')
    expect(body).toMatch(/if \(host\.dataset\.sig === sig\) return/)
    expect(body).toMatch(/host\.dataset\.sig = sig/)
    expect(body).toMatch(/classList\.contains\('rail-filter'\)/)
    expect(body).toMatch(/setSelectionRange\(caret, caret\)/)
    expect(body).toMatch(/railQuery = f\.value; renderRail\(\)/)
  })

  it('applies the visible-tab roving fallback in every responsive layout', () => {
    const body = fn('function renderRail()', '\n// the top bar')
    expect(body).toMatch(/if \(!tabs\.some\(\(tab\) => tab\.tabIndex === 0\) && tabs\[0\]\)/)
    expect(body).not.toMatch(/if \(tablet && !tabs\.some/)
  })

  it('promotes every programmatically focused project tab to the sole roving tab stop', () => {
    const promote = fn('function promoteProjectTab(', '\nfunction focusProjectTab(')
    expect(promote).toMatch(/if \(!projectTabIsOperable\(target\)\) return false/)
    expect(promote).toMatch(/querySelectorAll\('#rail \.rail-tab'\).*tabIndex = -1/)
    expect(promote).toMatch(/target\.tabIndex = 0/)
    expect(promote).toMatch(/target\.focus\(\)/)
    const restore = fn('function restoreProjectFocus(', '\nfunction setClosedProjectsOpen(')
    expect(restore).toMatch(/state\.kind === 'peek'/)
    expect(restore).toMatch(/state\.kind === 'trigger'.*promoteProjectTab/s)
    expect(restore).toMatch(/promoteProjectTab\(/)
    const close = fn('async function closeProjectAction(', '\nasync function reopenProjectAction(')
    expect(close).toMatch(/focusProjectTab\([^,]+,\s*generation\)/)
    const operable = fn('function projectTabIsOperable(', '\nfunction visibleProjectTabs(')
    expect(operable).toMatch(/projectNavigationMode\(\) === 'phone'/)
    expect(operable).toMatch(/dataset\.open !== 'true'/)
  })

  it('serializes project writes and reapplies every current optimistic intent after loading', () => {
    expect(js).toContain('const projectMutationIntents = new Map()')
    expect(js).toContain('const projectMutationQueues = new Map()')
    const loadBody = fn('async function load()', '\n// fix round 1 (hardening)')
    expect(loadBody).toContain('applyProjectMutationIntents()')
    const close = fn('async function closeProjectAction(', '\nasync function reopenProjectAction(')
    const reopen = fn('async function reopenProjectAction(', '\n// fix round 1: the query persists')
    for (const body of [close, reopen]) {
      expect(body).toMatch(/beginProjectMutation\(/)
      expect(body).toMatch(/await queueProjectMutation\(/)
      expect(body).toMatch(/if \(!ownsProjectMutation\(/)
    }
  })

  it('reconciles projectFilter against the FULL project list so a closed project can still be peeked', () => {
    const body = fn('function renderRail()', '\n// the top bar')
    expect(body).toMatch(/if \(projectFilter && !projects\.includes\(projectFilter\)\)/)
    expect(body, 'reconciling against the OPEN list would evict the peek on sight')
      .not.toMatch(/!open\.includes\(projectFilter\)/)
  })

  it('row actions stay beside the tab while only the explicit tablet Archive action joins the tab order', () => {
    // .rail-tab is itself a <button role="tab">; a button may not contain
    // interactive content. Desktop keeps §13's compact roving order; tablet
    // deliberately exposes Archive to keyboard and touch users.
    const body = fn('function railRowEl(', '\n// Projects as vertical tabs')
    expect(body).toMatch(/wrap\.appendChild\(/)
    const action = fn('function railActionEl(', '\nfunction closedFoldEl(')
    expect(action).toMatch(/tabIndex = tablet && !closed \? 0 : -1/)
    expect(action).toMatch(/setAttribute\('aria-label'/)
  })

  it('wireTablist skips tabs inside a collapsed <details>, or arrow keys focus invisible rows', () => {
    expect(fn('function wireTablist(', '\nfunction btn(')).toContain('details:not([open])')
  })

  it('the peek banner names the suppression instead of leaving two counts disagreeing', () => {
    const body = fn('function renderClosedBanner(', '\n// Projects as vertical tabs')
    expect(body).toContain('closed-banner')
    expect(body).toMatch(/textContent/)
    expect(body, 'a project name must never reach innerHTML').not.toMatch(/innerHTML/)
    expect(body).toMatch(/Inbox count or Review queue/)
    expect(body).toMatch(/reopenProjectAction\(/)
    // rendered in the editable frame above the panel host, so EVERY tab explains itself
    expect(fn('function paintEditableSurfaces(', '\nfunction render(')).toContain('renderClosedBanner()')
  })

  it('the optimistic close/reopen revert BY VALUE — a poll between click and response must not evict a bystander', () => {
    const close = fn('async function closeProjectAction(', '\nasync function reopenProjectAction(')
    const reopen = fn('async function reopenProjectAction(', '\n// fix round 1: the query persists')
    for (const [name, body] of [['close', close], ['reopen', reopen]] as const) {
      expect(body, `${name} must not splice by index`).not.toMatch(/\.splice\(/)
      expect(body, `${name} must route through postJSON`).toMatch(/postJSON\('\/api\/projects\//)
      expect(body, `${name} must bail out on a failed write`).toMatch(/=== null/)
    }
    expect(close).toMatch(/filter\(\(p\) => p !== name\)/)
    expect(reopen).toMatch(/includes\(name\)/)
  })
})

describe('closed-project css (issue #32)', () => {
  it('ships the fold, the row actions and the peek banner', () => {
    for (const rule of ['.closed-fold', '.rail-close', '.rail-reopen', '.closed-muted', '.closed-banner', '.rail-row']) {
      expect(css, rule).toContain(rule)
    }
  })

  it('closed rows never wear the escalated crimson badge', () => {
    expect(css).toMatch(/\.closed-fold \.rail-badge \{/)
  })

  it('a Reopen button inside the fold still responds to hover (equal specificity, later rule wins)', () => {
    // .closed-fold .rail-reopen and .rail-reopen:hover are both (0,2,0)/(0,1,1);
    // the dimmed fold rule must not silently beat the hover feedback
    expect(css.indexOf('.closed-fold .rail-reopen {')).toBeLessThan(css.indexOf('.rail-close:hover'))
  })

  it('the tablet project-management rules live INSIDE the single @media block', () => {
    const media = css.search(/@media\s*\(/)
    expect(css.indexOf('.project-disclosure.tablet-projects')).toBeGreaterThan(media)
    expect(css.indexOf('.closed-projects-popover')).toBeGreaterThan(media)
  })
})

// ── issue #38: `load()` is the poll's, `reloadAndPaint()` is the human's ──────
// The whole of #38 is one confusion between those two. `load()` repaints through
// `renderIfIdle()` — the §10 editable-surface gate — and one half-typed draft on
// another board means the human's own Send/Resolve/Archive gets NO LIST FRAME.
// The write landed (POST 200, row in the DB) and the viewer showed the old list
// indefinitely. Issue #39 later kept ambient signals live ahead of this gate.
//
// So there are exactly two shapes, and no third:
//   `load()`            — the poll's. Fetch, then ASK the gate. Two callers only:
//                         the boot call and setInterval.
//   `reloadAndPaint()`  — the human's. Fetch, then paint unconditionally.
//
// These are SOURCE pins because no runtime assertion can see them: a test can
// prove a click repaints, but only the text can prove the 3s interval was not
// "fixed" by wiring forceRender into load() — which would delete the gate and
// pass every behavioural test in test/dom/silent-send.test.ts. The
// anti-regression test at the foot of that file is the behavioural half; keep
// both, they fail for different mistakes.
describe('#38 · the poll keeps its gate, the human bypasses it', () => {
  it('the 3s interval still calls the GATED load(), not a painting variant', () => {
    const line = js.split('\n').map((l) => l.trim()).find((l) => l.startsWith('setInterval('))
    expect(line, 'no setInterval( statement found in app.js').toBeTruthy()
    expect(line).toBe('setInterval(load, 3000)')
    expect(line, 'the poll must never force a frame — that IS the gate').not.toMatch(/reloadAndPaint|forceRender/)
  })

  it('load() ends in renderIfIdle() and never forces a frame of its own', () => {
    const m = js.match(/async function load\(\)[\s\S]*?\n\}/)
    expect(m, 'load() not found').toBeTruthy()
    const body = m![0]
    expect(body).toContain('renderIfIdle()')
    expect(body, 'forcing a frame inside load() deletes the §10 gate for the poll too').not.toContain('forceRender')
  })

  it('refreshes ambient signals before the draft gate, but defers everything during a held press (#39)', () => {
    const body = sourceFn('function renderIfIdle()', '\n// called whenever a draft may have cleared')
    expect(body).toMatch(/if \(pressHeld\([^)]*\)\)[\s\S]*const frame = paintAmbient\(\)[\s\S]*if \(shouldDeferRender\(/)

    const ambient = sourceFn('function paintAmbient()', '\nfunction paintEditableSurfaces(')
    for (const call of ['applyBadge()', 'renderRail()', 'renderLiveBar(', 'setCount(']) {
      expect(ambient, `${call} must stay outside the draft gate`).toContain(call)
    }

    const editable = sourceFn('function paintEditableSurfaces(', '\nfunction render(')
    for (const call of ['renderLive(', 'renderNeedsYou(', 'renderGroups(', 'renderDone(', 'renderBoards(']) {
      expect(editable, `${call} must stay protected by the draft gate`).toContain(call)
    }
  })

  // The design's REJECTED option (a), pinned at the edit site. `openRows` is the
  // boards matrix's multi-open Set: unbounded, NEVER pruned, no single-open
  // discipline and no reconciliation — strandable by pagination, the archived
  // fold, the rail filter, hideCompleted and any agent board_upsert that drops a
  // row. Feeding it to the gate freezes every editable list and lights
  // #pauseHint for as long as any row is open, which is the C1 bug reconcileOpenRow
  // exists to close. It reads like a consistency cleanup ("openRowId is in there,
  // why isn't openRows?"), it is one line, and before this pin it passed the whole
  // suite. The behavioural half — the freeze, measured — is
  // test/dom/press-guard.test.ts's "the REJECTED fix" block; keep both. This one
  // fails at the declaration with the reason attached, that one fails with the cost.
  it('openRows is never fed to the §10 gate — the C1 freeze is one line away', () => {
    const m = js.match(/function suspendState\(\)[\s\S]*?\n\}/)
    expect(m, 'suspendState() not found').toBeTruthy()
    expect(m![0], 'openRows in suspendState() freezes every editable surface while any matrix row is expanded')
      .not.toContain('openRows')
    // …and not by the back door either: shouldDeferRender's argument is the same gate.
    const gate = js.match(/function renderIfIdle\(\)[\s\S]*?\n\}/)
    expect(gate, 'renderIfIdle() not found').toBeTruthy()
    expect(gate![0], 'the press guard is the boards panel\'s protection — openRows is not').not.toContain('openRows')
  })

  it('reloadAndPaint() awaits load() first, so the frame paints the SERVER state', () => {
    const m = js.match(/async function reloadAndPaint\(\)[\s\S]*?\n\}/)
    expect(m, 'reloadAndPaint() not found').toBeTruthy()
    expect(m![0]).toMatch(/await load\(\)[\s\S]*forceRender\(\)/)
  })

  it('every write a click initiates goes through it — one bare load() survives, the boot call', () => {
    // A bare `load()` as the last statement of a successful POST handler is
    // precisely the #38 defect, and it hid in EIGHT call sites (row annotate,
    // reply, resolve/dismiss, item note, archive, un-archive, close/reopen
    // project). setInterval passes `load` by reference, so it is not a call
    // expression and never matches here.
    const lines = js.split('\n').map((l) => l.trim())
    const bare = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^load\(\);?$/.test(line))
    expect(bare.length, `un-painted load() calls survive: ${JSON.stringify(bare)}`).toBe(1)
    // …and it is the boot call: the very next statement is the poll itself.
    expect(lines[bare[0]!.n]).toBe('setInterval(load, 3000)')

    // The awaited form belongs to reloadAndPaint and nowhere else — an `await
    // load()` anywhere else is the same defect wearing a keyword.
    const awaited = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^await\s+load\(\);?$/.test(line))
    expect(awaited.length, `stray await load(): ${JSON.stringify(awaited)}`).toBe(1)
    expect(lines[awaited[0]!.n - 2]).toBe('async function reloadAndPaint() {')
  })
})
