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
} from '../public/source.js'
import type { CachedLink, LinkedEntity } from '../public/source.js'

const REPO = new URL('..', import.meta.url).pathname
const NOW = Date.parse('2026-07-26T12:00:00.000Z')

function link(over: Partial<CachedLink> = {}): CachedLink {
  return {
    repo: 'shariqh/agent-inbox', branch: '30-x', provider: 'github',
    pr_number: 41, pr_url: 'https://github.com/shariqh/agent-inbox/pull/41',
    pr_title: 'source + PR links', pr_state: 'OPEN', pr_draft: false,
    review_decision: null, checks: 'none',
    issue_number: null, issue_url: null, issue_title: null,
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

  it('rebuilds linkIndex once per render, before the renderers run', () => {
    const start = js.indexOf('function render()')
    const fn = js.slice(start, js.indexOf('\nfunction ', start))
    expect(fn).toMatch(/linkIndex\s*=\s*indexLinks\(/)
    expect(fn.indexOf('linkIndex')).toBeLessThan(fn.indexOf('renderNeedsYou('))
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
    expect(fn).toContain('sourceBlockHtml(')
    // the `header ? ... : ''` ternary is what builds `head`; the source block
    // must not live inside it
    const headBlock = fn.slice(fn.indexOf('const head = header ?'), fn.indexOf('el.innerHTML'))
    expect(headBlock).not.toContain('sourceBlockHtml(')
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
})
