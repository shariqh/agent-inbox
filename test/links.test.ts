import { describe, expect, it } from 'vitest'
import { findPlainLinks, githubRef, linkedHtml, webLabel } from '../public/links.js'
import type { FoundLink } from '../public/links.js'
import { renderStructuredText } from '../public/structured-text.js'

const REPO = 'shariqh/agent-inbox'

// What one run of plain text yields: [kind, text, target] per link, in order.
function found(text: string, repo: string | null = REPO): Array<[string, string, string]> {
  return findPlainLinks(text, 0, text.length, { repo }).map((link) => [
    link.kind,
    link.text,
    link.kind === 'file' ? link.path : link.url,
  ])
}

describe('GitHub references (issue #300)', () => {
  it.each([
    ['See #287.', 'issue', '#287', 'https://github.com/shariqh/agent-inbox/issues/287'],
    ['PR #284 is green', 'pr', '#284', 'https://github.com/shariqh/agent-inbox/pull/284'],
    ['merged PR#284 today', 'pr', '#284', 'https://github.com/shariqh/agent-inbox/pull/284'],
    ['the pull request #12 needs review', 'pr', '#12', 'https://github.com/shariqh/agent-inbox/pull/12'],
    ['Fixes #3', 'issue', '#3', 'https://github.com/shariqh/agent-inbox/issues/3'],
    ['blocked on issue #5 still', 'issue', '#5', 'https://github.com/shariqh/agent-inbox/issues/5'],
    ['Answer-back (#7)', 'issue', '#7', 'https://github.com/shariqh/agent-inbox/issues/7'],
    ["PR #12's checks", 'pr', '#12', 'https://github.com/shariqh/agent-inbox/pull/12'],
    ['Refs: #301', 'issue', '#301', 'https://github.com/shariqh/agent-inbox/issues/301'],
    ['see shariqh/other#12 too', 'issue', 'shariqh/other#12', 'https://github.com/shariqh/other/issues/12'],
    ['and octo-org/repo.js#4', 'issue', 'octo-org/repo.js#4', 'https://github.com/octo-org/repo.js/issues/4'],
    ['PR shariqh/other#9 merged', 'pr', 'shariqh/other#9', 'https://github.com/shariqh/other/pull/9'],
  ])('links %j', (text, kind, label, url) => {
    expect(found(text)).toEqual([[kind, label, url]])
  })

  it('finds several references in one run and keeps prose between them', () => {
    expect(found('#287, #288 and #290; also (#12)–#15')).toEqual([
      ['issue', '#287', 'https://github.com/shariqh/agent-inbox/issues/287'],
      ['issue', '#288', 'https://github.com/shariqh/agent-inbox/issues/288'],
      ['issue', '#290', 'https://github.com/shariqh/agent-inbox/issues/290'],
      ['issue', '#12', 'https://github.com/shariqh/agent-inbox/issues/12'],
      ['issue', '#15', 'https://github.com/shariqh/agent-inbox/issues/15'],
    ])
  })

  it('keys a reference by its lowercased repository and number', () => {
    const [link] = findPlainLinks('Shariqh/Agent-Inbox#12', 0, 22, { repo: REPO })
    expect(link).toMatchObject({ kind: 'issue', key: 'shariqh/agent-inbox#12', repo: 'Shariqh/Agent-Inbox', number: 12 })
  })

  it.each([
    'the #1 priority',
    'option #2 is safer',
    'step #12 failed',
    'CI run #1234 failed',
    'build #567 is red',
    'Task #12 in the plan',
    'line #40 of the log',
    'color: #111',
    'use #fff or #000000',
    'C#12 and F# are languages',
    'entity &#60; stays',
    'version 1.2.3 on 2026-10-22',
    'ratio #12.5 or #12,345',
    '#0 and #012',
    '#12abc #12_x #12-beta',
    'issue#12',
    'a `#12` code span',
    'x/owner/name#12 is a path',
    'see #12345678 too long',
    'https#12',
  ])('leaves %j plain', (text) => {
    expect(found(text)).toEqual([])
  })

  it('needs the entity repository for a bare reference, but not for owner/name#N', () => {
    expect(found('See #287', null)).toEqual([])
    expect(found('PR #284', 'not a repo')).toEqual([])
    expect(found('see shariqh/other#12', null)).toEqual([
      ['issue', 'shariqh/other#12', 'https://github.com/shariqh/other/issues/12'],
    ])
  })

  it('never names a repository GitHub could not have', () => {
    expect(found('-bad/name#12 and bad-/name#12 and a_b/c#12 and o/..#12')).toEqual([])
  })
})

describe('local file paths (issue #300)', () => {
  it.each([
    ['Open /Users/s/Development/agent-inbox/docs/x.md now', '/Users/s/Development/agent-inbox/docs/x.md', '/Users/s/Development/agent-inbox/docs/x.md'],
    ['`/Users/s/a.md`', '/Users/s/a.md', '/Users/s/a.md'],
    ['(/Users/s/a.md)', '/Users/s/a.md', '/Users/s/a.md'],
    ['Read /Users/s/a.md.', '/Users/s/a.md', '/Users/s/a.md'],
    ['"/Users/s/a.md"', '/Users/s/a.md', '/Users/s/a.md'],
    ['flag --db=/Users/s/inbox.db', '/Users/s/inbox.db', '/Users/s/inbox.db'],
    ['~/Development/agent-inbox/README.md', '~/Development/agent-inbox/README.md', '~/Development/agent-inbox/README.md'],
    ['in /home/runner/work/x/y.txt', '/home/runner/work/x/y.txt', '/home/runner/work/x/y.txt'],
    ['log at /tmp/run/out.log', '/tmp/run/out.log', '/tmp/run/out.log'],
    ['/Applications/QLMarkdown.app', '/Applications/QLMarkdown.app', '/Applications/QLMarkdown.app'],
    ['folder /Users/s/dir/ here', '/Users/s/dir/', '/Users/s/dir/'],
    ['/Users/s/Résumé.pdf', '/Users/s/Résumé.pdf', '/Users/s/Résumé.pdf'],
    ['/Users/s/node_modules/@scope/pkg/index.js', '/Users/s/node_modules/@scope/pkg/index.js', '/Users/s/node_modules/@scope/pkg/index.js'],
    ['~/.agent-inbox/inbox.db', '~/.agent-inbox/inbox.db', '~/.agent-inbox/inbox.db'],
  ])('links %j', (text, label, path) => {
    expect(found(text)).toEqual([['file', label, path]])
  })

  it('keeps a :line suffix in the text and out of the path', () => {
    const text = 'at /Users/s/src/store.ts:1234:7, then ~/a.ts:12.'
    expect(findPlainLinks(text, 0, text.length, {})).toMatchObject([
      { kind: 'file', text: '/Users/s/src/store.ts:1234:7', path: '/Users/s/src/store.ts', line: 1234 },
      { kind: 'file', text: '~/a.ts:12', path: '~/a.ts', line: 12 },
    ])
  })

  it('finds several paths separated by prose or punctuation', () => {
    expect(found('Files: /Users/s/a.md, /Users/s/b.md and ~/c.md')).toEqual([
      ['file', '/Users/s/a.md', '/Users/s/a.md'],
      ['file', '/Users/s/b.md', '/Users/s/b.md'],
      ['file', '~/c.md', '~/c.md'],
    ])
  })

  it.each([
    'the /api/items route',
    'GET /api/version',
    'writes to /tmp',
    'everything under /Users today',
    'and/or w/o 1/2 s/foo/bar/',
    'file:///etc/passwd',
    '/Users/s/*.md',
    '/Users/s/a.md:symbol',
    'x/Users/s/a.md',
    '~user/x and ~/ alone',
    '/dev/null and /proc/1/status',
    '$HOME/x',
    '/Users/s/a.md#L12',
    '/Users/s/My Documents/a.md',
    '/Users/s/Project Notes.md',
    '/^\\/Users\\//',
  ])('leaves %j plain', (text) => {
    expect(found(text)).toEqual([])
  })

  it('does not end a path inside a token the next run continues', () => {
    // a URL candidate that structured-text could not link starts right after
    const text = '/Users/s/a.mdhttps://x.example'
    expect(findPlainLinks(text, 0, text.indexOf('https'), {})).toEqual([])
  })

  it('never reads a link past the end of its run', () => {
    expect(findPlainLinks('/Users/s/a.md rest', 0, 9, {})).toEqual([])
    expect(findPlainLinks('see #287 now', 0, 7, { repo: REPO })).toEqual([])
  })
})

describe('linkedHtml (issue #300)', () => {
  it('escapes the prose and renders a reference as an anchor and a path as an inert control', () => {
    const text = 'See #287 <b> & /Users/s/a "b".md and /Users/s/c.md:3'
    const html = linkedHtml(text, 0, text.length, { repo: REPO })
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('<a href="https://github.com/shariqh/agent-inbox/issues/287" target="_blank" rel="noopener noreferrer" class="structured-link" data-link-kind="issue">#287</a>')
    expect(html).toContain('<a class="structured-link file-link" role="button" tabindex="0" data-link-kind="file" data-link-path="/Users/s/c.md" title="/Users/s/c.md:3">/Users/s/c.md:3</a>')
    expect(html).not.toMatch(/href="[^"]*\/Users/)
  })

  it('collects every link it renders, in order, when asked to', () => {
    const found: FoundLink[] = []
    const text = 'PR #284 then ~/x.md'
    linkedHtml(text, 0, text.length, { repo: REPO, found })
    expect(found.map((link) => link.kind)).toEqual(['pr', 'file'])
  })
})

describe('structured text with detected links (issue #300)', () => {
  it('links references against the field repository and paths everywhere', () => {
    const html = renderStructuredText('See #287 and /Users/s/a.md', { repo: REPO })
    expect(html).toContain('href="https://github.com/shariqh/agent-inbox/issues/287"')
    expect(html).toContain('data-link-path="/Users/s/a.md"')
    expect(renderStructuredText('See #287')).not.toContain('<a ')
    expect(renderStructuredText('See /Users/s/a.md')).toContain('data-link-kind="file"')
  })

  it('marks web autolinks with their kind and collects them with the rest', () => {
    const found: FoundLink[] = []
    const html = renderStructuredText('Read https://example.com/a, then #12 at ~/b.md', { repo: REPO, found })
    expect(html).toContain('class="structured-link" data-link-kind="web">https://example.com/a</a>')
    expect(found.map((link) => link.kind)).toEqual(['web', 'issue', 'file'])
  })

  it('keeps fenced code and quarantined markup inert', () => {
    const found: FoundLink[] = []
    const html = renderStructuredText([
      '```sh',
      'cat /Users/s/a.md # see #287',
      '```',
      '',
      '<Component path="/Users/s/b.md"> #288',
      '',
      'Then /Users/s/c.md',
    ].join('\n'), { repo: REPO, found })
    expect(found.map((link) => ('text' in link ? link.text : link.url))).toEqual(['/Users/s/c.md'])
    expect(html).not.toContain('data-link-path="/Users/s/a.md"')
    expect(html).not.toContain('data-link-path="/Users/s/b.md"')
    expect(html).not.toContain('issues/288')
  })

  it('does not link a path glued to a URL candidate that stayed plain', () => {
    expect(renderStructuredText('/Users/s/a.mdhttps://x.example')).not.toContain('data-link-kind')
  })

  it('stays linear on hostile reference and path candidates', () => {
    const hostile = `${'#1 a/b#2 x/Users/a /Users/a* ~'.repeat(20_000)}\nSee /Users/s/ok.md`
    const started = performance.now()
    const html = renderStructuredText(hostile, { repo: REPO })
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(html).toContain('data-link-path="/Users/s/ok.md"')
  }, 10_000)
})

describe('labels for the Links strip (issue #300)', () => {
  it.each([
    ['https://github.com/shariqh/agent-inbox/pull/284', { kind: 'pr', repo: 'shariqh/agent-inbox', number: 284, key: 'shariqh/agent-inbox#284' }],
    ['https://github.com/Shariqh/Other/issues/12/', { kind: 'issue', repo: 'Shariqh/Other', number: 12, key: 'shariqh/other#12' }],
    ['https://github.com/o/n/pull/284/files', null],
    ['https://github.com/o/n/issues/12#issuecomment-1', null],
    ['https://example.com/o/n/pull/1', null],
    ['https://github.com/o/n/issues/0', null],
  ])('reads %s as a GitHub reference or not', (url, ref) => {
    expect(githubRef(url)).toEqual(ref)
  })

  it.each([
    ['https://www.example.com/', 'example.com'],
    ['https://docs.example.com/guide/start?x=1#top', 'docs.example.com/guide/start'],
    ['http://127.0.0.1:4319/api/items', '127.0.0.1:4319/api/items'],
    ['https://example.com/a/very/long/path/that/keeps/going/and/going/file.html', 'example.com/…/file.html'],
  ])('labels %s as host and path', (url, label) => {
    expect(webLabel(url)).toBe(label)
  })
})
