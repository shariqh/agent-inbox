import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  linkKey,
  indexLinks,
  linkFor,
  issueRef,
  prChip,
  prDetail,
  safeHttpUrl,
  sourceTooltip,
  sourceChipsHtml,
  sourceBlockHtml,
  issueRelationsHtml,
  rowIssueChipsHtml,
  previewRef,
  PREVIEW_TTL_MS,
  planGroupHeadHtml,
  rowParentHeadHtml,
  rowWaitsChipHtml,
  planWaitsChipHtml,
  rowWaitsHtml,
} from '../public/source.js'
import type { CachedLink, LinkedEntity } from '../public/source.js'
import { buildIssueView, planGroups } from '../public/issues.js'
import { buildIssueGraph } from '../src/issue-graph.js'
import type { IssueError } from '../src/store.js'
import { at, deps, facts, keySets, row, snapshot } from './issue-fixtures.js'

const REPO = new URL('..', import.meta.url).pathname
const NOW = Date.parse('2026-07-26T12:00:00.000Z')

function link(over: Partial<CachedLink> = {}): CachedLink {
  return {
    repo: 'shariqh/agent-inbox', branch: '30-x', head_repo: 'shariqh/agent-inbox', provider: 'github',
    pr_number: 41, pr_url: 'https://github.com/shariqh/agent-inbox/pull/41',
    pr_title: 'source + PR links', pr_state: 'OPEN', pr_draft: false,
    pr_head_sha: null,
    review_decision: null, checks: 'none',
    issue_number: null, issue_url: null, issue_title: null,
    preview_url: null, preview_environment: null, preview_deployment_id: null,
    preview_updated_at: null, preview_error: null, revision: 1,
    tldr: 'Links the inbox to its source issue and PR.',
    fetched_at: new Date(NOW - 60_000).toISOString(),
    checked_at: new Date(NOW - 60_000).toISOString(),
    error: null,
    ...over,
  }
}

const entity = (over: Partial<LinkedEntity> = {}): LinkedEntity =>
  ({ repo: 'shariqh/agent-inbox', stream: '30-x', issue_ref: 30, ...over })

describe('indexLinks / linkFor', () => {
  it('joins an item to its cache row by repo AND branch', () => {
    const index = indexLinks([link(), link({ branch: 'other', pr_number: 9 })])
    expect(linkFor(index, entity())!.pr_number).toBe(41)
    expect(linkFor(index, entity({ stream: 'other' }))!.pr_number).toBe(9)
    expect(linkFor(index, entity({ repo: 'someone/else' }))).toBeNull()
  })

  // issue #157 — a branch name is only unique within the repository it is pushed
  // to, so the join includes the head repository the cached PR was verified for
  it('joins only the row verified for the repository the entity\'s branch is pushed to', () => {
    const index = indexLinks([link(), link({ head_repo: 'me/agent-inbox', pr_number: 52 })])
    expect(linkFor(index, entity({ head_repo: 'me/agent-inbox' }))!.pr_number).toBe(52)
    expect(linkFor(index, entity({ head_repo: 'shariqh/agent-inbox' }))!.pr_number).toBe(41)
    // an entity raised before #157 recorded no head: it expects a same-repository PR
    expect(linkFor(index, entity())!.pr_number).toBe(41)
    expect(linkFor(index, entity({ head_repo: 'stranger/agent-inbox' }))).toBeNull()
    expect(linkFor(indexLinks([link({ head_repo: 'me/agent-inbox' })]), entity())).toBeNull()
    // issue #183 — a branch that tracks a pull request ref records that ref as
    // its head; it never falls back to the base's same-named branch row
    expect(linkFor(index, entity({ head_repo: 'refs/pull/7/head' }))).toBeNull()
  })

  describe('preview provenance and freshness', () => {
    const ready = () => link({
      pr_head_sha: 'a'.repeat(40),
      preview_url: 'https://preview.example/?x=1&y=2',
      preview_environment: 'Preview',
      preview_deployment_id: 1,
      preview_updated_at: new Date(NOW).toISOString(),
      fetched_at: new Date(NOW).toISOString(),
    })

    it('expires without another successful poll and rejects future cache timestamps', () => {
      expect(previewRef(ready(), NOW)).not.toBeNull()
      expect(previewRef(ready(), NOW + PREVIEW_TTL_MS)).toBeNull()
      expect(previewRef(ready(), NOW - 1)).toBeNull()
    })

    it('requires current PR provenance and a complete successful snapshot', () => {
      for (const change of [
        { pr_head_sha: null }, { pr_state: 'MERGED' }, { pr_number: null },
        { provider: 'gitlab' }, { preview_deployment_id: null }, { preview_updated_at: 'bad' },
        { fetched_at: 'bad' }, { error: 'offline' }, { preview_error: 'head-changed' },
      ]) {
        expect(previewRef({ ...ready(), ...change }, NOW)).toBeNull()
      }
    })

    it('escapes environment metadata and makes previews opt-in on each action surface', () => {
      const cached = { ...ready(), preview_environment: '"><img src=x onerror=alert(1)>' }
      const index = indexLinks([cached])
      expect(sourceChipsHtml(index, entity(), NOW)).not.toContain('data-preview-key')
      const html = sourceChipsHtml(index, entity(), NOW, { preview: true })
      expect(html).not.toContain('<img')
      expect(html).toContain('&quot;&gt;&lt;img')
      expect(html).toContain('href="https://preview.example/?x=1&amp;y=2"')
      expect(html).toContain('tabindex="-1"')
      expect(sourceBlockHtml(index, entity(), NOW, { preview: true })).not.toContain('tabindex="-1"')
    })

    // app.js re-validates a rendered preview anchor by looking its key up in
    // indexLinks(); a key built without the head would orphan a fork-PR preview
    it('keys a preview anchor exactly as indexLinks keys its cache row', () => {
      const fromFork = { ...ready(), head_repo: 'me/agent-inbox' }
      const index = indexLinks([fromFork])
      const [key] = [...index.keys()]
      const html = sourceChipsHtml(index, entity({ head_repo: 'me/agent-inbox' }), NOW, { preview: true })
      expect(html).toContain(`data-preview-key="${encodeURIComponent(key!)}"`)
    })
  })

  it('is null-safe for an entity with no repo or no branch, and for junk input', () => {
    const index = indexLinks([link()])
    expect(linkFor(index, entity({ repo: null }))).toBeNull()
    expect(linkFor(index, entity({ stream: '' }))).toBeNull()
    expect(indexLinks(null).size).toBe(0)
    expect(linkKey('a/b', 'c')).not.toBe(linkKey('a', 'b/c')) // the separator is not '/'
  })
})

describe('prChip priority', () => {
  it('merged beats everything, including red checks', () => {
    const c = prChip(link({ pr_state: 'MERGED', checks: 'failing', pr_draft: true }))!
    expect(c.word).toBe('merged')
    expect(c.tone).toBe('merged')
    expect(c.text).toBe('PR 41')
  })

  it('closed beats draft and checks', () => {
    expect(prChip(link({ pr_state: 'CLOSED', checks: 'failing' }))!.word).toBe('closed')
  })

  it('draft beats failing checks — a draft PR\'s red CI is expected', () => {
    expect(prChip(link({ pr_draft: true, checks: 'failing' }))!.word).toBe('draft')
  })

  it('failing checks beat changes-requested', () => {
    expect(prChip(link({ checks: 'failing', review_decision: 'CHANGES_REQUESTED' }))!.word).toBe('checks failing')
  })

  it('changes-requested beats approved, and approved shows only when checks are not failing', () => {
    expect(prChip(link({ review_decision: 'CHANGES_REQUESTED' }))!.word).toBe('changes requested')
    expect(prChip(link({ review_decision: 'APPROVED' }))!.word).toBe('approved')
    expect(prChip(link({ review_decision: 'APPROVED', checks: 'failing' }))!.word).toBe('checks failing')
  })

  it('falls back to pending checks, then plain open', () => {
    expect(prChip(link({ checks: 'pending' }))!.word).toBe('checks running')
    expect(prChip(link())!.word).toBe('open')
  })

  it('returns null when the cache row has no PR at all', () => {
    expect(prChip(link({ pr_number: null }))).toBeNull()
    expect(prChip(null)).toBeNull()
  })
})

describe('issueRef precedence', () => {
  it('renders the issue from repo + issue_ref with no cache row at all — the no-gh path', () => {
    const ref = issueRef(entity(), null)!
    expect(ref.num).toBe(30)
    expect(ref.url).toBe('https://github.com/shariqh/agent-inbox/issues/30')
  })

  it('the PR\'s closingIssuesReferences wins over the branch guess', () => {
    const ref = issueRef(entity(), link({ issue_number: 77, issue_url: 'https://github.com/shariqh/agent-inbox/issues/77' }))!
    expect(ref.num).toBe(77)
    expect(ref.url).toBe('https://github.com/shariqh/agent-inbox/issues/77')
  })

  it('is null when neither side knows an issue', () => {
    expect(issueRef(entity({ issue_ref: null }), null)).toBeNull()
    expect(issueRef(entity({ issue_ref: null, repo: null }), null)).toBeNull()
    expect(issueRef(null, null)).toBeNull()
  })

  it('needs a repo to build a url — with none it still names the issue, unlinked', () => {
    const ref = issueRef(entity({ repo: null }), null)!
    expect(ref.num).toBe(30)
    expect(ref.url).toBe('')
  })

  it('never carries an unsafe cached url through — it falls back to the constructed one', () => {
    const ref = issueRef(entity(), link({ issue_number: 30, issue_url: 'javascript:alert(1)' }))!
    expect(ref.url).toBe('https://github.com/shariqh/agent-inbox/issues/30')
    const noFallback = issueRef({ repo: null, stream: '30-x', issue_ref: null }, link({ repo: '', issue_number: 30, issue_url: 'javascript:alert(1)' }))!
    expect(noFallback.url).toBe('')
  })
})

// #30 introduces the FIRST anchors this product has ever built out of
// agent-supplied or network-supplied text. esc() escapes &<>"' for an HTML text
// context — it does NOTHING about a URL scheme, so it cannot stop a
// javascript: href on its own. safeHttpUrl is the only defence here.
describe('safeHttpUrl', () => {
  it('allows http and https, and normalises through the URL parser', () => {
    expect(safeHttpUrl('https://github.com/a/b/pull/1')).toBe('https://github.com/a/b/pull/1')
    expect(safeHttpUrl('http://localhost:4319/x')).toBe('http://localhost:4319/x')
  })

  it('refuses javascript:, in any casing', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBe('')
    expect(safeHttpUrl('JaVaScRiPt:alert(1)')).toBe('')
    expect(safeHttpUrl('JAVASCRIPT:alert(1)')).toBe('')
  })

  it('refuses a leading-whitespace or control-character smuggle', () => {
    expect(safeHttpUrl('\u0001javascript:alert(1)')).toBe('')
    expect(safeHttpUrl('  javascript:alert(1)')).toBe('')
    expect(safeHttpUrl('\n\tjavascript:alert(1)')).toBe('')
    expect(safeHttpUrl('java\nscript:alert(1)')).toBe('')
  })

  it('refuses data:, file:, vbscript: and protocol-relative urls', () => {
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe('')
    expect(safeHttpUrl('file:///etc/passwd')).toBe('')
    expect(safeHttpUrl('vbscript:msgbox(1)')).toBe('')
    expect(safeHttpUrl('//evil.com/x')).toBe('')
    expect(safeHttpUrl('/relative/path')).toBe('')
  })

  // never fall back to emitting the raw string on a parse failure
  it('returns empty string for junk, null and non-strings', () => {
    expect(safeHttpUrl('not a url')).toBe('')
    expect(safeHttpUrl('')).toBe('')
    expect(safeHttpUrl(null)).toBe('')
    expect(safeHttpUrl(undefined)).toBe('')
    expect(safeHttpUrl(42)).toBe('')
    expect(safeHttpUrl({ toString: () => 'https://ok.example' })).toBe('')
  })
})

describe('sourceTooltip and prDetail', () => {
  it('carries the PR title and the TL;DR, and says how stale the check is', () => {
    const tip = sourceTooltip(entity(), link(), NOW)
    expect(tip).toContain('PR 41')
    expect(tip).toContain('source + PR links')
    expect(tip).toContain('Links the inbox to its source issue and PR.')
    expect(tip).toMatch(/checked .* ago/)
  })

  it('says plainly when the last check failed, without hiding the stale good state', () => {
    const tip = sourceTooltip(entity(), link({ error: 'no-gh' }), NOW)
    expect(tip).toContain('PR 41')
    expect(tip.toLowerCase()).toContain('gh')
    expect(prDetail(link({ error: 'no-gh' }), NOW)!.error).toBeTruthy()
  })

  it('still describes the issue when there is no cache row at all', () => {
    expect(sourceTooltip(entity(), null, NOW)).toContain('#30')
    expect(prDetail(null, NOW)).toBeNull()
  })
})

// The escaping burden lives ENTIRELY inside public/source.js: app.js
// interpolates these two results RAW, so anything unescaped here reaches
// innerHTML. PR titles and bodies are the most attacker-influenced strings in
// the product — anyone who can open a PR against a repo you work in controls them.
describe('sourceChipsHtml / sourceBlockHtml escape every network-sourced field', () => {
  const XSS = '"><img src=x onerror=alert(1)>'
  const hostile = link({
    pr_title: XSS,
    tldr: XSS,
    issue_number: 30,
    issue_url: 'javascript:alert(1)',
    pr_url: 'javascript:alert(1)',
  })

  it('never emits a raw < or a raw " out of a PR title or body', () => {
    const index = indexLinks([hostile])
    for (const html of [sourceChipsHtml(index, entity(), NOW), sourceBlockHtml(index, entity(), NOW)]) {
      expect(html).not.toContain('<img')
      expect(html).not.toContain(XSS)          // the payload verbatim, quote and all
      expect(html).toContain('&quot;&gt;&lt;img') // …only ever as inert text
    }
  })

  // the PR has no safe url to fall back to, so its chip degrades to a plain
  // <span> — never a bare or half-escaped href
  it('emits no anchor at all for a javascript: url', () => {
    const index = indexLinks([hostile])
    for (const html of [sourceChipsHtml(index, entity(), NOW), sourceBlockHtml(index, entity(), NOW)]) {
      expect(html).not.toContain('javascript:')
      expect(html).not.toMatch(/href="[^"]*pull/)
      expect(html).toContain('<span class="src-chip tone-')
    }
  })

  it('renders no anchor for ANY chip once every url is hostile', () => {
    const noRepo = { repo: null, stream: '30-x', issue_ref: null }
    const html = sourceChipsHtml(indexLinks([link({ repo: '', branch: '30-x' })]), noRepo, NOW)
    expect(html).not.toContain('href=')
  })

  // repo is agent-authored too (register({ repo })), and the frontend CONSTRUCTS
  // https://github.com/<repo>/issues/<n> out of it
  it('escapes an attacker-influenced repo slug in the CONSTRUCTED issue url', () => {
    const html = sourceChipsHtml(new Map(), entity({ repo: 'a"onmouseover="alert(1)/b' }), NOW)
    expect(html).not.toContain('a"onmouseover')   // no quote breaks out of the attribute
    expect(html).toContain('a%22onmouseover')     // the URL parser percent-encoded it
  })

  it('builds a real anchor for a good https url, opening out of the app safely', () => {
    const html = sourceChipsHtml(indexLinks([link()]), entity(), NOW)
    expect(html).toContain('href="https://github.com/shariqh/agent-inbox/pull/41"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('target="_blank"')
    // §13's roving tab order belongs to the ROWS — chips must not interleave into it
    expect(html).toContain('tabindex="-1"')
  })

  it('renders nothing at all when there is no repo, no issue and no cache row', () => {
    expect(sourceChipsHtml(new Map(), entity({ repo: null, issue_ref: null }), NOW)).toBe('')
    expect(sourceBlockHtml(new Map(), entity({ repo: null, issue_ref: null }), NOW)).toBe('')
    expect(sourceChipsHtml(new Map(), null, NOW)).toBe('')
    expect(sourceBlockHtml(new Map(), null, NOW)).toBe('')
  })

  it('renders the issue chip with no cache row — the no-gh, no-network path', () => {
    const html = sourceChipsHtml(new Map(), entity(), NOW)
    expect(html).toContain('#30')
    expect(html).toContain('href="https://github.com/shariqh/agent-inbox/issues/30"')
    expect(html).not.toContain('PR ')
  })

  it('the card block carries the SOURCE label, the state word and the TL;DR', () => {
    const html = sourceBlockHtml(indexLinks([link({ pr_state: 'MERGED' })]), entity(), NOW)
    expect(html).toContain('card-source')
    expect(html).toContain('SOURCE')
    expect(html).toContain('merged')
    expect(html).toContain('Links the inbox to its source issue and PR.')
    // card chips ARE tabbable — they are inside an already-expanded surface
    expect(html).not.toContain('tabindex="-1"')
  })
})

// ── source-level pins: the wiring no unit test can observe ───────────────────

describe('public/source.js keeps the URL guard in exactly one place', () => {
  const src = readFileSync(join(REPO, 'public/source.js'), 'utf8')
  // a name surviving only inside prose must not read as alive — the same
  // comment-stripping idiom test/dead-exports.test.ts uses
  const code = src.split('\n').filter((l) => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  }).join('\n')

  it('builds every href through esc(safeHttpUrl(...)), and builds only one', () => {
    const hrefs = src.match(/href="/g) ?? []
    expect(hrefs).toHaveLength(1)
    expect(src).toMatch(/href="\$\{esc\(safeHttpUrl\(/)
  })

  it('imports esc RELATIVELY so the same file resolves in the browser and under vitest', () => {
    expect(src).toMatch(/import\s*\{\s*esc\s*\}\s*from\s*'\.\/esc\.js'/)
    expect(src).not.toContain("from '/esc.js'")
  })

  it('has no DOM access — it is a pure view-model module like rowview.js and boards.js', () => {
    for (const token of ['document.', 'window.', 'innerHTML', 'addEventListener']) {
      expect(code, `source.js touches ${token}`).not.toContain(token)
    }
  })
})

describe('app.js wires the source chips without re-implementing the escaping', () => {
  const js = readFileSync(join(REPO, 'public/app.js'), 'utf8')

  it('imports the builders from /source.js and declares linkIndex at module scope', () => {
    expect(js).toMatch(/import\s*\{[^}]*sourceChipsHtml[^}]*\}\s*from\s*'\/source\.js'/)
    expect(js).toMatch(/let\s+linkIndex\s*=\s*new Map\(\)/)
  })

  it('load() fetches /api/links, defensively enough that an old server cannot blank the page', () => {
    const start = js.indexOf('async function load()')
    const fn = js.slice(start, js.indexOf('\nasync function postJSON('))
    expect(fn).toContain('/api/links')
    expect(fn).toMatch(/links/)
    expect(fn).toContain('.catch(() => [])')
  })

  it('rebuilds linkIndex in the ambient frame before editable renderers run', () => {
    const ambientStart = js.indexOf('function paintAmbient()')
    const ambient = js.slice(ambientStart, js.indexOf('\nfunction paintTabCounts(', ambientStart))
    expect(ambient).toMatch(/linkIndex\s*=\s*indexLinks\(/)

    const renderStart = js.indexOf('function render()')
    const render = js.slice(renderStart, js.indexOf('\nfunction ', renderStart + 1))
    expect(render).toMatch(/preparedFrame \?\? paintAmbient\(\)[\s\S]*paintEditableSurfaces\(frame\)/)
  })

  // the escaping happens inside source.js; interpolating its result through
  // esc() again would render literal &lt;a&gt; instead of a link
  it('interpolates the builders RAW, and constructs no href of its own', () => {
    expect(js).not.toMatch(/esc\(\s*source(Chips|Block)Html/)
    expect(js).not.toContain('href=')
  })

  it('renders the row chip between the urgency chip and the star slot', () => {
    const start = js.indexOf('function needsRowEl(')
    const fn = js.slice(start, js.indexOf('\nfunction rowCardBodyEl('))
    expect(fn).toContain('nrow-src')
    expect(fn).toContain('sourceChipsHtml(')
    expect(fn.indexOf('nrow-src')).toBeLessThan(fn.indexOf('nrow-star'))
  })

  it('renders the card block OUTSIDE the header gate, so notes and done cards get it too', () => {
    const start = js.indexOf('function itemCardEl(')
    const fn = js.slice(start, js.indexOf('\nasync function changeAnswer('))
    const headBlock = fn.match(/\$\{header \?[\s\S]*?: ''\}/)?.[0]
    expect(headBlock).toBeDefined()
    expect(headBlock).not.toContain('cardDetailsHtml(')
    expect(fn).toContain('${cardDetailsHtml(it, it, `item:${it.id}`, presentation, { includeAsked })}')
    const detailsStart = js.indexOf('function cardDetailsHtml(')
    const details = js.slice(detailsStart, js.indexOf('\nfunction bindContextDisclosures(', detailsStart))
    expect(details).toContain('${sourceBlockHtml(linkIndex, identity, Date.now(), sourceOptions(entity, identity))}')
  })

  // a <summary>'s activation toggles its <details>: a chip inside .board-meta
  // would navigate AND collapse the card, writing a spurious collapsedCards entry
  it('puts the board chips outside <summary>, so clicking one cannot toggle the card', () => {
    const start = js.indexOf('function boardEl(')
    const fn = js.slice(start, js.indexOf('\nfunction archiveBtn('))
    expect(fn).toContain('board-source')
    expect(fn).toContain('sourceChipsHtml(')
    const summary = fn.slice(fn.indexOf('<summary'), fn.indexOf('</summary>'))
    expect(summary).not.toContain('sourceChipsHtml(')
  })
})

describe('the source chip styling stays inside the one @media invariant', () => {
  const css = readFileSync(join(REPO, 'public/style.css'), 'utf8')

  it('declares the chip classes', () => {
    for (const cls of ['.src-chip', '.nrow-src', '.card-source', '.board-source', '.src-tldr', '.src-checked']) {
      expect(css, `${cls} is unstyled`).toContain(cls)
    }
  })

  it('drops only the state WORD at narrow width, and does so inside the single @media block', () => {
    const idx = css.search(/@media\s*\(/)
    expect(idx).toBeGreaterThan(-1)
    expect(css.slice(0, idx)).not.toContain('.src-word { display: none')
    expect(css.slice(idx)).toContain('.nrow-src .src-word { display: none; }')
  })

  // #103: relationship chips are ambient; a stale one is dimmed, never alarming
  it('declares the sub-issue classes, and dims a stale chip without the danger colour', () => {
    for (const cls of ['.src-chip.tone-stale', '.src-sep', '.src-progress', '.src-trail', '.src-children', '.src-child', '.src-activity', '.src-more', '.board-issues', '.row-src']) {
      expect(css, `${cls} is unstyled`).toContain(cls)
    }
    const stale = css.match(/\.src-chip\.tone-stale \{([^}]*)\}/)?.[1] ?? ''
    expect(stale).toMatch(/opacity:\s*\.\d+/)
    expect(stale).not.toContain('danger')
    expect(css.indexOf('.src-chip.tone-stale')).toBeLessThan(css.search(/@media\s*\(/))
  })
})

// ── issue #103 PR3: breadcrumbs and child progress (§7) ─────────────────────
// The relationship chips and block sections are drawn here too, so the two
// dangers above apply to GitHub-authored issue titles and to the issue URLs
// this file constructs from a validated slug and number.
describe('issue relationships in the chips and the source block (#103)', () => {
  const R = 'shariqh/agent-inbox'
  const K = (n: number): string => `${R}#${n}`
  const T = Date.parse(at(0))
  const PARENT = 'Integrate Agent Inbox with Agent Host Protocol'
  const item120 = { repo: R, stream: '120-ahp-input', issue_ref: 120 }
  const plan117 = { repo: R, stream: '119-ahp-adapter', issue_ref: 119, issue_pin_repo: R, issue_pin_number: 117, project: 'agent-inbox' }

  function family(opts: { parentTitle?: string; childTitle?: string; fetchedAt?: string; error?: IssueError } = {}) {
    const fetchedAt = opts.fetchedAt ?? at(0)
    const extra = opts.error ? { error: opts.error, checkedAt: at(100) } : {}
    const children = [118, 119, 120].map((n) => facts(K(n), n === 118
      ? { state: 'CLOSED', state_reason: 'COMPLETED' }
      : n === 120 ? { title: opts.childTitle ?? 'Import unresolved AHP input requests into Needs you' } : {}))
    const rows = [
      row(K(117), snapshot(K(117), { issue: { title: opts.parentTitle ?? PARENT }, children, total: 10, completed: 1 }), fetchedAt, extra),
      row(K(120), snapshot(K(120), {
        issue: { title: opts.childTitle ?? 'Import unresolved AHP input requests into Needs you' },
        ancestors: [facts(K(117), { title: opts.parentTitle ?? PARENT, children_total: 10, children_completed: 1 })],
      }), fetchedAt, extra),
    ]
    return buildIssueGraph(rows, keySets(rows.map((r) => `${r.repo}#${r.number}`)))
  }
  // the view and the builders read one clock, as one frame of the viewer does
  const NOW3 = T + 3 * 60_000
  const view = (graph: unknown, extra: Partial<Parameters<typeof buildIssueView>[1]> = {}) =>
    buildIssueView(graph, { nowMs: NOW3, ...extra })
  const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!)

  // AC2: what main rendered before PR3, byte for byte (captured from cb70cf81)
  it('renders exactly today\'s chips and block when there is no relationship to draw', () => {
    const PLAIN = '<a href="https://github.com/shariqh/agent-inbox/issues/120" target="_blank" rel="noopener noreferrer" class="src-chip tone-issue" title="issue #120" tabindex="-1">#120</a>'
    const BLOCK = '<div class="card-source"><div class="card-source-label">SOURCE</div><div class="src-row"><a href="https://github.com/shariqh/agent-inbox/issues/120" target="_blank" rel="noopener noreferrer" class="src-chip tone-issue">#120</a></div></div>'
    const capped = buildIssueView(buildIssueGraph(
      [row(K(117), snapshot(K(117)), at(0)), row(K(120), snapshot(K(120), { ancestors: [K(117)] }), at(0))],
      keySets([K(117), K(120)]), { maxUnits: 1 }), { nowMs: T })
    const soft = buildIssueView(buildIssueGraph([row(K(120), null, null, { error: 'no-gh', checkedAt: at(1) })], keySets([K(120)])), { nowMs: T })
    for (const issues of [undefined, null, view(null), capped, soft]) {
      expect(sourceChipsHtml(new Map(), item120, T, { issues })).toBe(PLAIN)
      expect(sourceBlockHtml(new Map(), item120, T, { issues })).toBe(BLOCK)
    }
  })

  it('shows a child its exact parent as its own anchor, and a parent its progress', () => {
    const issues = view(family())
    const chips = sourceChipsHtml(new Map(), item120, NOW3, { issues })
    expect(chips).toBe(
      '<a href="https://github.com/shariqh/agent-inbox/issues/117" target="_blank" rel="noopener noreferrer" class="src-chip tone-issue"'
      + ` title="Parent: #117 ${PARENT} (1 of 10 done) · checked 3m ago" tabindex="-1" data-issue-key="shariqh/agent-inbox#117" aria-label="Parent issue #117">#117</a>`
      + '<span class="src-sep" aria-hidden="true">›</span>'
      + '<a href="https://github.com/shariqh/agent-inbox/issues/120" target="_blank" rel="noopener noreferrer" class="src-chip tone-issue"'
      + ' title="issue #120 — Import unresolved AHP input requests into Needs you · checked 3m ago" tabindex="-1" data-issue-key="shariqh/agent-inbox#120">#120</a>',
    )
    // the plan's pin outranks its branch issue (#119), and it is a parent
    const plan = sourceChipsHtml(new Map(), plan117, NOW3, { issues, tabbable: true })
    expect(plan).toContain('>#117 <span class="src-progress">· 1/10</span></a>')
    expect(plan).not.toContain('#119')
  })

  it('lists the children in GitHub order with their marks, titles and Agent Inbox activity', () => {
    const question = { id: 'q120', project: 'agent-inbox', agent: 'claude-code', kind: 'question', title: 'Which parent?', status: 'open', ...item120, created_at: at(1), updated_at: at(1) }
    const issues = view(family(), {
      items: [question], attention: [{ kind: 'item', item: question, liveness: 'waiting' }],
      boards: [{ id: 'p1', project: 'agent-inbox', agent: 'copilot', title: 'Adapter', status: 'active', repo: R, stream: 'main', updated_at: at(2),
        rows: [{ id: 'r119', label: 'Build the adapter', status: 'partial', issue_repo: R, issue_number: 119, updated_at: at(2) }] }],
    })
    const block = issueRelationsHtml(new Map(), plan117, NOW3, { issues })
    expect(block).toContain('Sub-issues on GitHub · 1 of 10 done')
    expect(block.indexOf('#118')).toBeLessThan(block.indexOf('#119'))
    expect(block.indexOf('#119')).toBeLessThan(block.indexOf('#120'))
    expect(block).toContain('aria-label="completed"')
    expect(block).toContain('<button type="button" class="src-activity" data-issue-open="p1" data-issue-row="r119">Active · copilot · Build the adapter</button>')
    expect(block).toContain('<button type="button" class="src-activity" data-issue-open="q120">Waiting on you</button>')
    expect(block).toContain('<span class="src-activity">None here</span>')
    expect(block).toContain('+7 not visible to your GitHub account')
    expect(block).toContain('Relationships checked 3m ago')
    // the card block of the child carries its trail above its own row
    const child = sourceBlockHtml(new Map(), item120, NOW3, { issues })
    expect(child.indexOf('#117')).toBeLessThan(child.indexOf('#120'))
    expect(child).toContain(PARENT)
  })

  it('dims stale relationships with their age and reason, hides expired ones, and says why one is unavailable', () => {
    const TWO_HOURS = T + 2 * 60 * 60_000
    const stale = view(family({ error: 'auth' }), { nowMs: TWO_HOURS })
    const chips = sourceChipsHtml(new Map(), item120, TWO_HOURS, { issues: stale })
    expect(chips.match(/class="src-chip tone-stale"/g)).toHaveLength(2)
    expect(chips).toContain('· as of 2h ago')
    expect(chips).toContain('gh is not logged in — showing the last state it saw')

    const EIGHT_DAYS = T + 8 * 24 * 60 * 60_000
    const expired = view(family(), { nowMs: EIGHT_DAYS })
    expect(sourceChipsHtml(new Map(), item120, EIGHT_DAYS, { issues: expired }))
      .toBe(sourceChipsHtml(new Map(), item120, EIGHT_DAYS, { issues: null }))
    expect(sourceBlockHtml(new Map(), item120, EIGHT_DAYS, { issues: expired })).toContain('Relationships unavailable — last seen 8d ago')

    const reasons = {
      'not-found': 'GitHub says this issue does not exist or is not visible',
      forbidden: 'GitHub denied access (SSO?)',
      moved: 'GitHub answered with another issue — update the link',
    } as const
    for (const [error, reason] of Object.entries(reasons)) {
      // refused after a success: the cached titles must not survive
      const graph = buildIssueGraph([
        row(K(120), null, null, { error: error as IssueError, checkedAt: at(5) }),
      ], keySets([K(120)]))
      const issues = view(graph)
      const html = sourceChipsHtml(new Map(), item120, NOW3, { issues }) + sourceBlockHtml(new Map(), item120, NOW3, { issues })
      expect(html).toContain('#120 <span class="src-word">unavailable</span>')
      expect(html).toContain(reason)
      expect(html).not.toContain('Import unresolved')
      expect(html).not.toContain('#117')
    }
  })

  // Review round 1: GitHub returned the issue but not its parent or sub-issues.
  // Nothing is known about its relationships, so it never reads "checked".
  it('draws an issue GitHub returned without its hierarchy like an expired one: the plain chip and one line', () => {
    const issues = view(buildIssueGraph([
      row(K(117), snapshot(K(117), { issue: { title: PARENT }, children: [K(120)] }), at(0)),
      row(K(120), snapshot(K(120), { unavailable: true }), at(0)),
    ], keySets([K(117), K(120)])))
    const line = 'Relationships unavailable — GitHub returned this issue but not its parent or sub-issues'
    expect(sourceChipsHtml(new Map(), item120, NOW3, { issues })).toBe(sourceChipsHtml(new Map(), item120, NOW3, { issues: null }))
    const block = sourceBlockHtml(new Map(), item120, NOW3, { issues })
    expect(block).toContain(line)
    expect(block.replace(/<[^>]*>/g, ' ')).not.toMatch(/checked|as of|#117/)
    expect(issueRelationsHtml(new Map(), { ...plan117, issue_pin_number: 120 }, NOW3, { issues }))
      .toBe(`<div class="card-source src-relations"><div class="src-checked">${line}</div></div>`)
  })

  it('renders hostile titles as inert text, including quotes inside title=', () => {
    const XSS = '"><img src=x onerror=alert(1)>'
    const QUOTES = `It's "quoted" & <b>bold</b>`
    const hostile = { id: 'x"><img src=x>', project: 'agent-inbox', agent: XSS, kind: 'note', title: QUOTES, status: 'open', ...item120, issue_ref: 118, stream: '118-x', created_at: at(1), updated_at: at(1) }
    const issues = view(family({ parentTitle: XSS, childTitle: QUOTES }), { items: [hostile] })
    const html = [
      sourceChipsHtml(new Map(), item120, NOW3, { issues }),
      sourceBlockHtml(new Map(), item120, NOW3, { issues }),
      issueRelationsHtml(new Map(), plan117, NOW3, { issues }),
    ].join('\n')
    // the tooltip is plain text, escaped where it is interpolated into title=
    expect(sourceTooltip(item120, null, NOW3, { issues })).toContain(`issue #120 — ${QUOTES}`)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('It&#39;s &quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;')
    expect(html).toContain('data-issue-open="x&quot;&gt;&lt;img src=x&gt;"')
    // every attribute value is closed by the quote that opened it
    for (const tag of html.match(/<[a-z][^>]*>/g) ?? []) expect(tag.split('"').length % 2, tag).toBe(1)
  })

  it('constructs every href from a validated slug and number, through the one anchor path', () => {
    const issues = view(family())
    const html = sourceChipsHtml(new Map(), item120, NOW3, { issues }) + issueRelationsHtml(new Map(), plan117, NOW3, { issues })
      + sourceBlockHtml(new Map(), item120, NOW3, { issues })
    expect(hrefs(html).length).toBeGreaterThan(5)
    for (const href of hrefs(html)) expect(href).toMatch(/^https:\/\/github\.com\/shariqh\/agent-inbox\/issues\/\d+$/)
    // a node that is not a valid slug and number is never a link (issues.js
    // drops it; this file still refuses to build an href from one)
    const forged = { ...issues, relations: new Map([[K(120), {
      ...issues.relations.get(K(120))!,
      trail: [{ key: 'x', repo: 'javascript:alert(1)//', number: 1, title: 't', state: 'OPEN' as const, mark: 'open' as const }],
    }]]) }
    const bad = sourceChipsHtml(new Map(), item120, NOW3, { issues: forged })
    expect(bad).not.toContain('javascript:')
    expect(hrefs(bad)).toEqual(['https://github.com/shariqh/agent-inbox/issues/120'])
  })

  it('keeps relationship chips neutral and never says Blocked', () => {
    const blockedRow = { id: 'r120', label: 'Answer the agent', status: 'blocked', issue_repo: R, issue_number: 120, updated_at: at(1) }
    const board = { id: 'p1', project: 'agent-inbox', agent: 'copilot', title: 'Rollout', status: 'active', repo: R, stream: 'main', updated_at: at(1), rows: [blockedRow] }
    const outputs: string[] = []
    for (const [graph, nowMs] of [[family(), T], [family({ error: 'offline' }), T + 60 * 60_000], [family(), T + 9 * 24 * 60 * 60_000]] as const) {
      const issues = view(graph, { nowMs, boards: [board], attention: [{ kind: 'row', row: blockedRow, board }] })
      outputs.push(
        sourceChipsHtml(new Map(), item120, nowMs, { issues }), sourceBlockHtml(new Map(), item120, nowMs, { issues }),
        issueRelationsHtml(new Map(), plan117, nowMs, { issues }), rowIssueChipsHtml(blockedRow, board, nowMs, { issues }),
      )
    }
    const html = outputs.join('\n')
    expect(html).toContain('Waiting on you')
    expect(html).not.toMatch(/blocked/i)
    expect(html).not.toContain('tone-bad')
    for (const [, tone] of html.matchAll(/class="src-chip tone-([\w-]+)"/g)) expect(['issue', 'stale']).toContain(tone)
  })

  // Slice 2 §7.5: the group header is a heading, never a control, and every
  // GitHub or agent text in it is inert.
  it('draws a group header and a row run header with hostile titles as inert text', () => {
    const XSS = '"><img src=x onerror=alert(1)>'
    const QUOTES = `It's "quoted" & <b>bold</b>`
    const issues = view(family({ parentTitle: XSS, childTitle: QUOTES }))
    const plans = [
      { id: 'umb', project: QUOTES, agent: XSS, title: XSS, repo: R, stream: 'main', issue_pin_repo: R, issue_pin_number: 117 },
      { id: 'p120', project: QUOTES, agent: XSS, title: QUOTES, repo: R, stream: 'main', issue_pin_repo: R, issue_pin_number: 120 },
    ]
    const group = planGroups(plans, issues, null).groupOf.get('umb')!
    const head = planGroupHeadHtml(group, NOW3)
    expect(head.startsWith('<h3 class="plan-group-head">')).toBe(true)
    expect(head.replace(/<[^>]*>/g, '')).toBe(`#117${XSS}1 of 10 sub-issues done · 2 plans · ${QUOTES}`
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'))
    expect(planGroupHeadHtml(group, NOW3, { continued: true })).toContain('(continued)')
    const run = rowParentHeadHtml(issues.relations.get(K(120))!.trail[0]!, plans[0]!)
    expect(run).toBe(`<th colspan="5" scope="colgroup" class="row-parent-head" title="${XSS.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}">Part of #117</th>`)
    const html = head + run
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).not.toMatch(/blocked/i)
    expect(hrefs(html)).toEqual(['https://github.com/shariqh/agent-inbox/issues/117'])
    for (const tag of html.match(/<[a-z][^>]*>/g) ?? []) expect(tag.split('"').length % 2, tag).toBe(1)
    for (const [, tone] of html.matchAll(/class="src-chip tone-([\w-]+)"/g)) expect(tone).toBe('issue')

    // a group of stale members is dimmed and says how old its evidence is
    const stale = planGroups(plans, view(family({ fetchedAt: at(0) }), { nowMs: T + 2 * 60 * 60_000 }), null).groupOf.get('umb')!
    const dim = planGroupHeadHtml(stale, T + 2 * 60 * 60_000)
    expect(dim.startsWith('<h3 class="plan-group-head stale">')).toBe(true)
    expect(dim).toContain('class="src-chip tone-stale"')
    expect(dim).toContain(' · as of 2h ago')
  })

  it('names a row\'s own issue instead of its plan\'s, and draws nothing for a row with no link', () => {
    const issues = view(family())
    const linkedRow = { id: 'r1', label: 'Wire input', status: 'tracked', issue_repo: R, issue_number: 120 }
    const rowChips = rowIssueChipsHtml(linkedRow, plan117, NOW3, { issues })
    expect(rowChips).toContain('>#117</a><span class="src-sep" aria-hidden="true">›</span>')
    expect(rowChips).toContain('>#120</a>')
    expect(rowIssueChipsHtml({ id: 'r2', label: 'Plain', status: 'tracked' }, plan117, NOW3, { issues })).toBe('')
    // the row's card shows the row's issue where it would show the plan's
    expect(sourceChipsHtml(new Map(), plan117, NOW3, { issues, row: linkedRow })).toContain('data-issue-key="shariqh/agent-inbox#120"')
    expect(sourceChipsHtml(new Map(), plan117, NOW3, { issues, row: { id: 'r2' } })).toContain('· 1/10')
  })

  it('never guesses which of several closed issues a PR belongs to, and lists them all', () => {
    const fetched = link().fetched_at
    const several = link({
      issue_number: 5, issue_url: 'https://github.com/shariqh/agent-inbox/issues/5',
      closing_refs: JSON.stringify({ fetched_at: fetched, refs: [{ repo: R, number: 5 }, { repo: 'cli/cli', number: 6 }] }),
    })
    const noBranchIssue = entity({ issue_ref: null })
    expect(issueRef(noBranchIssue, several)).toBeNull()
    expect(sourceChipsHtml(indexLinks([several]), noBranchIssue, NOW)).not.toContain('issues/5')
    // the entity falls back to its branch issue, and the PR tooltip lists every one
    expect(issueRef(entity(), several)!.num).toBe(30)
    expect(sourceTooltip(entity(), several, NOW)).toContain('closes #5, cli/cli#6')
    expect(sourceBlockHtml(indexLinks([several]), entity(), NOW)).toContain('closes #5, cli/cli#6')
    // one bound reference is certain, and reads exactly as #30 always has
    const one = link({ issue_number: 5, closing_refs: { fetched_at: fetched, refs: [{ repo: R, number: 5 }] } })
    expect(issueRef(entity(), one)).toMatchObject({ num: 5, key: K(5), certain: true })
    expect(sourceTooltip(entity(), one, NOW)).not.toContain('closes')
  })
})

// Slice 2 PR D (§9.1): "waits on" chips, "Dependencies on GitHub" and the row
// detail's "Waits on". A dependency is never the human's blocker, so none of it
// uses the bad tone, the blocked mark or the word "Blocked".
describe('dependency chips and blocks in Plans (slice 2 PR D)', () => {
  const R = 'shariqh/agent-inbox'
  const K = (n: number): string => `${R}#${n}`
  const T = Date.parse(at(0))
  const NOW3 = T + 3 * 60_000
  const XSS = '"><img src=x onerror=alert(1)>'
  const QUOTES = `It's "quoted" & <b>bold</b>`
  const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!)
  const text = (html: string): string => html.replace(/<[^>]*>/g, '')
  const rows = [
    { id: 'rb', label: 'Build', status: 'done', issue_repo: R, issue_number: 119 },
    { id: 'rs', label: QUOTES, status: 'tracked', issue_repo: R, issue_number: 120 },
    { id: 'rp', label: 'Ship', status: 'partial', issue_repo: R, issue_number: 121, waits_on: ['Build', 'Gone', QUOTES] },
    { id: 'rd', label: 'Doc', status: 'tracked', waits_on: [QUOTES] },
    { id: 'rq', label: 'Quiet', status: 'tracked', waits_on: ['Build'] },
    { id: 'r1', label: 'One', status: 'tracked', issue_repo: R, issue_number: 122 },
  ]
  const plan = { id: 'p', project: 'agent-inbox', agent: 'copilot', title: 'Release', status: 'active', repo: R, stream: 'main',
    issue_ref: null, issue_pin_repo: R, issue_pin_number: 121, updated_at: at(1), rows }
  function graph(opts: { title?: string; error?: IssueError; section?: 'ok' | 'unavailable' | 'none' } = {}) {
    const title = opts.title ?? 'Title of #120'
    const extra = opts.error ? { error: opts.error, checkedAt: at(100) } : {}
    const section = opts.section ?? 'ok'
    const dependencies = (d: Parameters<typeof deps>[0]) => (section === 'ok' ? deps(d) : section === 'unavailable' ? { status: 'unavailable' as const } : null)
    const snaps = [
      row(K(121), snapshot(K(121)), at(0), { ...extra, dependencies: dependencies({
        blockedBy: [facts(K(119)), facts(K(120), { title }), facts('Other/Repo#5', { title }), facts(K(118), { state: 'CLOSED', state_reason: 'COMPLETED', title: 'closed blocker' })],
        blocking: [facts(K(130), { title }), facts(K(131), { state: 'CLOSED', title: 'closed dependent' })],
        blockedByCounts: { open: 5, total: 7 },
      }) }),
      // #122 waits only on #119, and #124 and #125 wait on each other
      row(K(122), snapshot(K(122)), at(0), { ...extra, dependencies: dependencies({ blockedBy: [K(119)] }) }),
      row(K(124), snapshot(K(124)), at(0), { ...extra, dependencies: dependencies({ blockedBy: [K(125)], blocking: [K(125)] }) }),
    ]
    return buildIssueGraph(snaps, keySets(snaps.map((r) => `${r.repo}#${r.number}`)))
  }
  const view = (g: unknown, nowMs = NOW3, extra: Partial<Parameters<typeof buildIssueView>[1]> = {}) =>
    buildIssueView(g, { boards: [plan], nowMs, ...extra })
  const byId = (id: string) => rows.find((r) => r.id === id)!

  it('says what a row waits on in one chip: one issue, several, one step, several steps', () => {
    const issues = view(graph())
    // GitHub: #119, #120 and other/repo#5 are open; the step on #120 merges with its issue
    const ship = rowWaitsChipHtml(byId('rp'), plan, NOW3, { issues })
    expect(text(ship)).toBe('waits on 3')
    expect(ship).toMatch(/^<span class="src-chip tone-issue" title="[^"]*" tabindex="-1" data-waits-on="3">/)
    const tip = ship.match(/title="([^"]*)"/)![1]!
    expect(tip).toBe([
      'Waits on:',
      'step It&#39;s &quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt; (#120 Title of #120) — step in this plan · GitHub',
      'Other/Repo#5 Title of #120 — GitHub',
      '#119 Title of shariqh/agent-inbox#119 — GitHub',
      'checked 3m ago',
    ].join('\n'))
    // one issue is a link, built from its slug and number
    const one = rowWaitsChipHtml(byId('r1'), plan, NOW3, { issues, tabbable: true })
    expect(one).toBe('<a href="https://github.com/shariqh/agent-inbox/issues/119" target="_blank" rel="noopener noreferrer" class="src-chip tone-issue"'
      + ' title="Waits on:\n#119 Title of shariqh/agent-inbox#119 — GitHub\nchecked 3m ago" data-waits-on="1">waits on #119</a>')
    const doc = rowWaitsChipHtml(byId('rd'), plan, NOW3, { issues })
    expect(text(doc)).toBe('waits on step It&#39;s &quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;')
    expect(doc).toContain('title="Waits on:\nstep It&#39;s &quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt; — step in this plan"')
    expect(hrefs(doc)).toEqual([])
    const steps = { ...plan, rows: [...rows, { id: 'rm', label: 'Many', status: 'tracked', waits_on: ['Doc', 'One'] }] }
    expect(text(rowWaitsChipHtml({ id: 'rm' }, steps, NOW3, { issues: view(null, NOW3, { boards: [steps] }) }))).toBe('waits on 2 steps')
    // nothing open: a done step, a dangling label, no link and no waits
    for (const id of ['rq', 'rb', 'rs']) expect(rowWaitsChipHtml(byId(id), plan, NOW3, { issues })).toBe('')
    expect(rowWaitsChipHtml(byId('rp'), plan, NOW3, {})).toBe('')
  })

  it('gives a plan the same chip for its own issue', () => {
    const issues = view(graph())
    const chip = planWaitsChipHtml(plan, NOW3, { issues, tabbable: true })
    expect(text(chip)).toBe('waits on 3')
    expect(chip).not.toContain('tabindex')
    expect(planWaitsChipHtml({ ...plan, id: 'other' }, NOW3, { issues })).toBe('')
  })

  it('lists "Dependencies on GitHub" below the sub-issues, open ones only, with activity and every count', () => {
    const question = { id: 'q', project: 'agent-inbox', agent: 'claude-code', kind: 'question', title: 'Which?', status: 'open',
      repo: R, stream: '119-x', issue_ref: 119, created_at: at(1), updated_at: at(1) }
    const issues = view(graph(), NOW3, { items: [question], attention: [{ kind: 'item', item: question, liveness: 'waiting' }] })
    const block = issueRelationsHtml(new Map(), plan, NOW3, { issues })
    expect(block).toContain('<div class="src-children-head">Dependencies on GitHub</div>')
    const waits = block.slice(block.indexOf('>Waits on<'), block.indexOf('>Unblocks<'))
    expect(waits).toContain('<ul class="src-child-list src-dep-list" aria-label="Waits on">')
    expect(waits.indexOf('Other/Repo#5')).toBeLessThan(waits.indexOf('#119'))
    expect(waits).toContain('<button type="button" class="src-activity" data-issue-open="q">Waiting on you</button>')
    expect(waits).toContain('Active · copilot · ')
    expect(waits).toContain('<li class="src-more">+2 not visible to your GitHub account</li>')
    expect(waits).not.toContain('closed blocker')
    const unblocks = block.slice(block.indexOf('>Unblocks<'))
    expect(unblocks).toContain('href="https://github.com/shariqh/agent-inbox/issues/130"')
    expect(unblocks).not.toContain('closed dependent')
    expect(block).not.toContain('Circular')
    expect(block).toContain('Relationships checked 3m ago')
    // the cycle through #124
    const row122 = issueRelationsHtml(new Map(), { ...plan, issue_pin_number: 124 }, NOW3, { issues })
    expect(row122).toContain('<div class="src-checked">Circular dependency on GitHub</div>')
    // the card block draws the same section
    expect(sourceBlockHtml(new Map(), plan, NOW3, { issues })).toContain('Dependencies on GitHub')
    // the node cap's count, once for the section
    const capped = { ...issues, relations: new Map([[K(121), { ...issues.relations.get(K(121))!, dependencies: {
      ...(issues.relations.get(K(121))!.dependencies as Extract<NonNullable<ReturnType<typeof issues.relations.get>>['dependencies'], { status: 'ok' }>),
      more: { waitsOn: { notVisible: 0, onGitHub: 4 }, unblocks: { notVisible: 0, onGitHub: 0 }, notShown: 2 } } }]]) }
    const cut = issueRelationsHtml(new Map(), plan, NOW3, { issues: capped })
    expect(cut).toContain('<li class="src-more">+4 more on GitHub</li>')
    expect(cut).toContain('<div class="src-more">+2 not shown</div>')
  })

  it('dims a stale section, and draws nothing unless GitHub answered: unknown, unavailable, expired, refused', () => {
    const stale = view(graph({ error: 'offline' }), T + 60 * 60_000)
    const chip = rowWaitsChipHtml(byId('r1'), plan, T + 60 * 60_000, { issues: stale })
    expect(chip).toContain('class="src-chip tone-stale"')
    expect(chip).toContain('as of 1h ago')
    expect(issueRelationsHtml(new Map(), plan, T + 60 * 60_000, { issues: stale })).toContain('Dependencies on GitHub')

    const unknown = view(graph({ section: 'none' }))
    expect(rowWaitsChipHtml(byId('r1'), plan, NOW3, { issues: unknown })).toBe('')
    expect(text(rowWaitsChipHtml(byId('rp'), plan, NOW3, { issues: unknown }))).toBe('waits on step It&#39;s &quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;')
    expect(issueRelationsHtml(new Map(), plan, NOW3, { issues: unknown })).not.toMatch(/Dependenc/)
    const refused = view(graph({ section: 'unavailable' }))
    expect(planWaitsChipHtml(plan, NOW3, { issues: refused })).toBe('')
    expect(issueRelationsHtml(new Map(), plan, NOW3, { issues: refused }))
      .toContain('<div class="src-checked">Dependencies unavailable — GitHub returned this issue but not its dependencies</div>')
    for (const [g, nowMs] of [[graph(), T + 8 * 24 * 60 * 60_000], [graph({ error: 'not-found' }), NOW3], [null, NOW3]] as const) {
      const issues = view(g, nowMs)
      expect(planWaitsChipHtml(plan, nowMs, { issues })).toBe('')
      expect(rowWaitsChipHtml(byId('r1'), plan, nowMs, { issues })).toBe('')
      expect(issueRelationsHtml(new Map(), plan, nowMs, { issues })).not.toMatch(/Dependenc|Waits on/)
    }
  })

  it('lists both kinds in the row detail, each with its source, and the pair once', () => {
    const issues = view(graph())
    const html = rowWaitsHtml(byId('rp'), plan, NOW3, { issues })
    expect(html.startsWith('<div class="card-source src-waits"><div class="card-source-label">WAITS ON</div><ul class="src-wait-list">')).toBe(true)
    expect(html.match(/<li /g)).toHaveLength(3)
    expect(html).toContain('<span class="src-step">step It&#39;s &quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;</span>')
    expect(html).toContain('<span class="src-wait-source">step in this plan · GitHub</span>')
    expect(html.match(/src-wait-source">GitHub</g)).toHaveLength(2)
    expect(rowWaitsHtml(byId('rd'), plan, NOW3, { issues })).toContain('<span class="src-wait-source">step in this plan</span>')
    expect(rowWaitsHtml(byId('rs'), plan, NOW3, { issues })).toBe('')
  })

  it('renders hostile GitHub titles and labels as inert text everywhere, and never builds an href from them', () => {
    const issues = view(graph({ title: XSS }), NOW3, { items: [{ id: XSS, project: 'agent-inbox', agent: XSS, kind: 'note', title: XSS,
      status: 'open', repo: R, stream: '130-x', issue_ref: 130, created_at: at(1), updated_at: at(1) }] })
    const html = [
      rowWaitsChipHtml(byId('rp'), plan, NOW3, { issues }), rowWaitsChipHtml(byId('rd'), plan, NOW3, { issues }),
      planWaitsChipHtml(plan, NOW3, { issues }), rowWaitsHtml(byId('rp'), plan, NOW3, { issues }),
      issueRelationsHtml(new Map(), plan, NOW3, { issues }), sourceBlockHtml(new Map(), plan, NOW3, { issues }),
    ].join('\n')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('data-issue-open="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"')
    for (const tag of html.match(/<[a-z][^>]*>/g) ?? []) expect(tag.split('"').length % 2, tag).toBe(1)
    for (const href of hrefs(html)) expect(href).toMatch(/^https:\/\/github\.com\/(shariqh\/agent-inbox|Other\/Repo)\/issues\/\d+$/)
    // a forged node that is no valid slug and number is never a link
    const rel = issues.relations.get(K(121))!
    const okDeps = rel.dependencies as Extract<typeof rel.dependencies, { status: 'ok' }>
    const forgedNode = { key: 'x', repo: 'javascript:alert(1)//', number: 1, title: 't', state: 'OPEN' as const, mark: 'open' as const }
    const forged = {
      ...issues,
      relations: new Map([[K(121), { ...rel, dependencies: { ...okDeps, waitsOn: [{ node: forgedNode, activity: okDeps.waitsOn[0]!.activity }] } }]]),
      rowWaits: new Map([['r1', [{ step: null, node: forgedNode, freshness: 'fresh' as const, fetchedAt: at(0), sources: ['github' as const] }]]]),
      planWaits: new Map(),
    }
    const bad = issueRelationsHtml(new Map(), plan, NOW3, { issues: forged }) + rowWaitsChipHtml(byId('r1'), plan, NOW3, { issues: forged })
      + rowWaitsHtml(byId('r1'), plan, NOW3, { issues: forged })
    expect(bad).not.toContain('javascript:')
  })

  it('styles the new classes outside the one @media block, with no danger colour', () => {
    const css = readFileSync(join(REPO, 'public/style.css'), 'utf8')
    const media = css.search(/@media\s*\(/)
    for (const cls of ['.src-deps-head', '.src-wait-list', '.src-wait ', '.src-step', '.src-wait-source']) {
      expect(css, `${cls} is unstyled`).toContain(cls)
      expect(css.indexOf(cls)).toBeLessThan(media)
    }
    const block = css.slice(css.indexOf('.src-deps-head'), css.indexOf('.src-wait-source'))
    expect(block).not.toMatch(/danger|--bad|red/)
  })

  it('keeps every dependency chip neutral and never says Blocked, even on a blocked row', () => {
    const blockedPlan = { ...plan, rows: rows.map((r) => ({ ...r, status: r.id === 'rp' ? 'blocked' : r.status })) }
    const outputs: string[] = []
    for (const [g, nowMs] of [[graph(), NOW3], [graph({ error: 'offline' }), T + 60 * 60_000]] as const) {
      const issues = view(g, nowMs, { boards: [blockedPlan], attention: [{ kind: 'row', row: blockedPlan.rows[2]!, board: blockedPlan }] })
      for (const r of blockedPlan.rows) outputs.push(rowWaitsChipHtml(r, blockedPlan, nowMs, { issues }), rowWaitsHtml(r, blockedPlan, nowMs, { issues }))
      outputs.push(planWaitsChipHtml(blockedPlan, nowMs, { issues }), issueRelationsHtml(new Map(), { ...blockedPlan, issue_pin_number: 124 }, nowMs, { issues }))
    }
    const html = outputs.join('\n')
    expect(html).toContain('waits on')
    expect(html).toContain('Circular dependency')
    expect(html).not.toMatch(/blocked/i)
    expect(html).not.toContain('tone-bad')
    for (const [, tone] of html.matchAll(/class="src-chip tone-([\w-]+)"/g)) expect(['issue', 'stale']).toContain(tone)
  })
})

describe('app.js reads the issue graph like links, and renders it without fetching', () => {
  const js = readFileSync(join(REPO, 'public/app.js'), 'utf8')
  const fn = (name: string): string => {
    const start = js.indexOf(`function ${name}(`)
    return js.slice(start, js.indexOf('\nfunction ', start + 1))
  }

  it('starts /api/issues with the poll\'s other reads, through its own snapshot validator, and falls back', () => {
    const load = js.slice(js.indexOf('async function load()'), js.indexOf('\nasync function postJSON('))
    expect(load).toContain("readSnapshot('/api/issues').then(marked)")
    expect(load).toContain('issuesBody(issuesRead)')
    const body = js.slice(js.indexOf('async function issuesBody('), js.indexOf('\nasync function load()'))
    expect(body).toMatch(/catch\s*\{\s*return null\s*\}/)
  })

  it('rebuilds the issue view in the ambient frame from attention it only reads', () => {
    const ambient = fn('paintAmbient')
    expect(ambient.indexOf('linkIndex = indexLinks(')).toBeLessThan(ambient.indexOf('issueView = buildIssueView('))
    expect(ambient.indexOf('applyBadge()')).toBeLessThan(ambient.indexOf('issueView = buildIssueView('))
    for (const name of ['render', 'paintEditableSurfaces', 'paintAmbient', 'boardEl', 'needsRowEl', 'cardDetailsHtml', 'cardOriginHtml', 'sourceOptions', 'rowPanelEl']) {
      expect(fn(name), `${name} fetches`).not.toMatch(/\bfetch\(|readSnapshot\(|\bload\(\)/)
    }
  })

  it('opens an activity label through focusItem, and keeps chip clicks from toggling a plan row', () => {
    expect(fn('openIssueActivity')).toContain('focusItem(')
    expect(fn('bindContextDisclosures')).toContain('bindIssueActivity(')
    // slice 2 §9.1: the row detail's "Waits on"
    expect(fn('rowPanelEl')).toContain('rowWaitsHtml(')
    expect(fn('boardEl')).toContain("closest('button, input, a')")
  })
})
