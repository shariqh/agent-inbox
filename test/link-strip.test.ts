import { describe, expect, it } from 'vitest'
import { cardLinks } from '../public/link-strip.js'
import type { CardLink } from '../public/link-strip.js'
import { indexLinks, linkStripHtml } from '../public/source.js'
import type { CachedLink } from '../public/source.js'

const REPO = 'shariqh/agent-inbox'
const NOW = Date.parse('2026-10-22T12:00:00.000Z')

function link(over: Partial<CachedLink> = {}): CachedLink {
  return {
    repo: REPO, branch: '300-links', head_repo: REPO, provider: 'github',
    pr_number: 284, pr_url: 'https://github.com/shariqh/agent-inbox/pull/284',
    pr_title: 'Links in the Inbox', pr_state: 'OPEN', pr_draft: false, pr_head_sha: null,
    review_decision: null, checks: 'none',
    issue_number: null, issue_url: null, issue_title: null,
    preview_url: null, preview_environment: null, preview_deployment_id: null,
    preview_updated_at: null, preview_error: null, revision: 1, tldr: null,
    fetched_at: new Date(NOW - 60_000).toISOString(), checked_at: new Date(NOW - 60_000).toISOString(),
    error: null,
    ...over,
  }
}

const brief = (links: CardLink[]) => links.map((l) => [l.kind, l.label, l.own])

describe('cardLinks (issue #300)', () => {
  it('puts the item’s own PR and issue first, then the text’s links in order of first appearance, once each', () => {
    const item = {
      id: 'i1', repo: REPO, stream: '300-links', issue_ref: 300,
      title: 'Review /Users/s/docs/spec.md',
      detail: 'See https://example.com/a and PR #284',
      impact: 'Blocks #301',
      context: 'Also https://example.com/a again, #300, ~/notes.md:4 and ~/notes.md:9',
    }
    expect(brief(cardLinks(item, item, indexLinks([link()])))).toEqual([
      ['pr', '#284', true],
      ['issue', '#300', true],
      ['file', 'spec.md', false],
      ['web', 'example.com/a', false],
      ['issue', '#301', false],
      ['file', 'notes.md:4', false],
    ])
  })

  it('reads every agent-written field, options included', () => {
    const item = {
      id: 'i2', repo: REPO,
      title: 'https://t.example/1', next_step: 'https://n.example/2', detail: 'https://d.example/3',
      impact: 'https://i.example/4', next_after: 'https://a.example/5', outcome: 'https://o.example/6',
      options: [{ label: 'Merge PR #582', detail: 'see https://od.example/7' }],
      context: 'https://c.example/8',
      reply: 'https://human.example/never', annotation: 'https://human.example/never',
    }
    expect(cardLinks(item, item, null).map((l) => l.label)).toEqual([
      't.example/1', 'n.example/2', 'd.example/3', 'i.example/4', 'a.example/5', 'o.example/6', '#582', 'od.example/7', 'c.example/8',
    ])
  })

  it('reads a plan row’s label and note, against its plan’s repository, with the row’s own issue link', () => {
    const plan = { id: 'b1', repo: REPO, stream: '300-links', issue_ref: 300 }
    const row = { id: 'r1', label: 'Ship #290', note: 'Spec at ~/s.md', issue_repo: REPO, issue_number: 299 }
    expect(brief(cardLinks(row, plan, indexLinks([link()])))).toEqual([
      ['pr', '#284', true],
      ['issue', '#299', true],
      ['issue', '#290', false],
      ['file', 's.md', false],
    ])
  })

  it('treats a GitHub PR or issue URL as the same target as its reference, and names other repositories', () => {
    const item = {
      id: 'i3', repo: REPO, stream: '300-links',
      detail: 'https://github.com/shariqh/agent-inbox/pull/284 and https://github.com/octo/other/issues/5 and #290, later PR #290',
    }
    expect(cardLinks(item, item, indexLinks([link()])).map((l) => [l.kind, l.label, l.url])).toEqual([
      ['pr', '#284', 'https://github.com/shariqh/agent-inbox/pull/284'],
      ['issue', 'octo/other#5', 'https://github.com/octo/other/issues/5'],
      ['pr', '#290', 'https://github.com/shariqh/agent-inbox/pull/290'],
    ])
  })

  it('draws no strip when the text links nothing beyond the item’s own PR and issue', () => {
    const item = { id: 'i4', repo: REPO, stream: '300-links', issue_ref: 300, detail: 'PR #284 closes #300' }
    expect(cardLinks(item, item, indexLinks([link()]))).toEqual([])
    expect(cardLinks({ id: 'i5', title: 'nothing here' }, { id: 'i5' }, null)).toEqual([])
  })

  it('lists only what the card renders: nothing from fenced code or quarantined markup', () => {
    const item = { id: 'i6', repo: REPO, context: '```\nopen /Users/s/a.md\n```\n\n<Widget href="https://x.example"> ~/b.md' }
    expect(cardLinks(item, item, null)).toEqual([])
  })
})

describe('linkStripHtml (issue #300)', () => {
  const links = (n: number): CardLink[] => Array.from({ length: n }, (_, i) => ({
    kind: 'web' as const, key: `web:${i}`, url: `https://example.com/${i}`, label: `example.com/${i}`, title: `https://example.com/${i}`, own: false,
  }))

  it('draws each chip with its kind and label, web links as anchors and files as buttons with no href', () => {
    const html = linkStripHtml([
      { kind: 'pr', url: 'https://github.com/o/n/pull/1', label: '#1', title: 'Pull request o/n#1' },
      { kind: 'file', path: '/Users/s/a.md', label: 'a.md', title: '/Users/s/a.md' },
    ], { key: 'links:x' })
    expect(html).toContain('role="group" aria-label="Links"')
    expect(html).toContain('<a href="https://github.com/o/n/pull/1" target="_blank" rel="noopener noreferrer" class="src-chip tone-link" title="Pull request o/n#1" data-link-kind="pr"><span class="link-kind">PR</span> <span class="link-label">#1</span></a>')
    expect(html).toContain('<button type="button" class="src-chip tone-link" data-link-kind="file" data-link-path="/Users/s/a.md" title="/Users/s/a.md"><span class="link-kind">File</span> <span class="link-label">a.md</span></button>')
  })

  it('escapes every agent-influenced value and drops a chip whose URL is not http(s)', () => {
    const html = linkStripHtml([
      { kind: 'file', path: '/Users/s/"><img src=x onerror=alert(1)>.md', label: '<script>x</script>', title: '"><b>' },
      { kind: 'web', url: 'javascript:alert(1)', label: 'evil' },
      { kind: 'nope' as 'web', url: 'https://example.com', label: 'unknown kind' },
    ], { key: '"><i>' })
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('unknown kind')
    expect(html).not.toContain('evil')
    expect(html).toContain('data-link-path="/Users/s/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.md"')
    expect(linkStripHtml([], { key: 'k' })).toBe('')
  })

  it('shows six chips and folds the rest into a keyed "+N more" disclosure that keeps its open state', () => {
    const closed = linkStripHtml(links(9), { key: 'links:i1' })
    expect(closed.match(/class="src-chip/g)).toHaveLength(9)
    expect(closed).toContain('<details class="card-links-more" data-context-key="links:i1"><summary>+3 more</summary>')
    expect(closed.indexOf('example.com/5')).toBeLessThan(closed.indexOf('<details'))
    expect(closed.indexOf('example.com/6')).toBeGreaterThan(closed.indexOf('<details'))
    expect(linkStripHtml(links(9), { key: 'links:i1', open: true })).toContain('data-context-key="links:i1" open>')
    expect(linkStripHtml(links(6), { key: 'links:i1' })).not.toContain('<details')
  })
})

describe('repo-relative files in the strip (issue #324)', () => {
  const ROOT = '/Users/s/Development/agent-inbox'

  it('lists a relative path against the card’s folder, one chip with the same file named in full', () => {
    const item = {
      id: 'i7', repo: REPO, repo_root: ROOT,
      detail: 'Spec at docs/spec.md:12, also /Users/s/Development/agent-inbox/docs/spec.md and public/app.js',
    }
    expect(cardLinks(item, item, null).map((l) => [l.kind, l.label, l.path, l.root, l.title, l.key])).toEqual([
      ['file', 'spec.md:12', 'docs/spec.md', ROOT, `${ROOT}/docs/spec.md:12`, `file:${ROOT}/docs/spec.md`],
      ['file', 'app.js', 'public/app.js', ROOT, `${ROOT}/public/app.js`, `file:${ROOT}/public/app.js`],
    ])
  })

  it('reads a plan row against its plan’s folder, and lists nothing relative without one', () => {
    const row = { id: 'r2', label: 'Draft docs/spec.md', note: 'See public/app.js:12' }
    expect(cardLinks(row, { id: 'b2', repo: REPO, repo_root: ROOT }, null).map((l) => [l.path, l.root])).toEqual([
      ['docs/spec.md', ROOT], ['public/app.js', ROOT],
    ])
    expect(cardLinks(row, { id: 'b3', repo: REPO }, null)).toEqual([])
    expect(cardLinks(row, { id: 'b4', repo: REPO, repo_root: null }, null)).toEqual([])
    // the row's own fields never name a folder: only its plan's counts
    expect(cardLinks({ ...row, repo_root: ROOT }, { id: 'b5', repo: REPO }, null)).toEqual([])
  })

  it('draws a relative chip with its folder on the chip and both actions, and the full path in its title', () => {
    const chip = { kind: 'file' as const, path: 'docs/a.md', root: '/Users/s/"r"', label: 'a.md', title: '/Users/s/"r"/docs/a.md:3' }
    const html = linkStripHtml([chip], { key: 'k', actions: { reveal: 'Reveal in Finder' } })
    expect(html).toContain('data-link-kind="file" data-link-path="docs/a.md" data-link-root="/Users/s/&quot;r&quot;" title="/Users/s/&quot;r&quot;/docs/a.md:3"')
    expect(html.match(/data-link-path="docs\/a\.md" data-link-root="\/Users\/s\/&quot;r&quot;"/g)).toHaveLength(3)
    expect(linkStripHtml([chip], { key: 'k', copyFiles: true })).toContain('title="Copy path: /Users/s/&quot;r&quot;/docs/a.md"')
    expect(linkStripHtml([{ ...chip, root: '' }], { key: 'k' })).not.toContain('data-link-root')
  })
})
