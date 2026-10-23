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

// Issue #324: a repo-relative path links only in a card that recorded the folder
// of the repository its session ran in, and only when it looks unmistakably
// like a file: a folder and a name, an extension or a :line, no `.` or `..`.
describe('repo-relative paths, only where the card knows its repository folder (issue #324)', () => {
  const ROOT = '/Users/s/Development/agent-inbox'
  const rel = (text: string, root: unknown = ROOT): Array<[string, string, string]> =>
    findPlainLinks(text, 0, text.length, { repo: REPO, root } as never).map((link) => [
      link.kind,
      link.text,
      link.kind === 'file' ? link.path : link.url,
    ])

  it.each([
    ['See docs/superpowers/specs/2026-10-21-plan-dependencies-design.md §4', 'docs/superpowers/specs/2026-10-21-plan-dependencies-design.md', 'docs/superpowers/specs/2026-10-21-plan-dependencies-design.md'],
    ['at public/app.js:7491.', 'public/app.js:7491', 'public/app.js'],
    ['`src/store.ts`', 'src/store.ts', 'src/store.ts'],
    ['(electron/main.cjs:374-380)', 'electron/main.cjs:374-380', 'electron/main.cjs'],
    ['"test/dom/card-links.test.ts"', 'test/dom/card-links.test.ts', 'test/dom/card-links.test.ts'],
    ['“docs/a.md”', 'docs/a.md', 'docs/a.md'],
    ['edit .github/copilot-instructions.md', '.github/copilot-instructions.md', '.github/copilot-instructions.md'],
    ['run ./scripts/install-agents.sh --apply', './scripts/install-agents.sh', 'scripts/install-agents.sh'],
    ['public/links.d.ts', 'public/links.d.ts', 'public/links.d.ts'],
    ['node_modules/@types/node/index.d.ts', 'node_modules/@types/node/index.d.ts', 'node_modules/@types/node/index.d.ts'],
    ['assets/LOGO.PNG', 'assets/LOGO.PNG', 'assets/LOGO.PNG'],
    ['docs/résumé.md', 'docs/résumé.md', 'docs/résumé.md'],
    ['bin/agent-inbox:12', 'bin/agent-inbox:12', 'bin/agent-inbox'],
    ['.husky/pre-commit:3', '.husky/pre-commit:3', '.husky/pre-commit'],
    ['docker/Dockerfile:12', 'docker/Dockerfile:12', 'docker/Dockerfile'],
    ['zsh/.zshrc:4', 'zsh/.zshrc:4', 'zsh/.zshrc'],
    ['config/.env.local', 'config/.env.local', 'config/.env.local'],
    ['notes/2026/10/report.md', 'notes/2026/10/report.md', 'notes/2026/10/report.md'],
    ['in src/a.ts:12:5, then', 'src/a.ts:12:5', 'src/a.ts'],
    ["src/store.ts's tests", 'src/store.ts', 'src/store.ts'],
    ['--file=docs/x.md', 'docs/x.md', 'docs/x.md'],
    ['see docs/x.md…', 'docs/x.md', 'docs/x.md'],
  ])('links %j', (text, label, path) => {
    expect(rel(text)).toEqual([['file', label, path]])
  })

  it('carries the folder and the full path it opens, and a :line out of the path', () => {
    const text = 'Read ./docs/spec.md:12 and public/app.js'
    expect(findPlainLinks(text, 0, text.length, { root: ROOT })).toEqual([
      { kind: 'file', start: 5, end: 22, text: './docs/spec.md:12', path: 'docs/spec.md', line: 12, root: ROOT, title: `${ROOT}/docs/spec.md:12` },
      { kind: 'file', start: 27, end: 40, text: 'public/app.js', path: 'public/app.js', line: null, root: ROOT, title: `${ROOT}/public/app.js` },
    ])
    expect(findPlainLinks('docs/a.md', 0, 9, { root: '/' })).toMatchObject([{ path: 'docs/a.md', title: '/docs/a.md' }])
    expect(findPlainLinks('docs/a.md', 0, 9, { root: 'C:/Users/s/repo' })).toMatchObject([{ title: 'C:/Users/s/repo/docs/a.md' }])
  })

  it('links none without a usable folder: relative paths stay plain text, as before', () => {
    const text = 'Read docs/spec.md and public/app.js:7491'
    for (const root of [undefined, null, '', 'relative/root', 'Users/s', 42, '/Users/s/\nrepo', '/Users/s/\u0000repo', `/${'a'.repeat(5000)}`]) {
      expect(findPlainLinks(text, 0, text.length, { repo: REPO, root } as never), String(root)).toEqual([])
    }
    expect(findPlainLinks(text, 0, text.length, { repo: REPO })).toEqual([])
    expect(rel(text)).toHaveLength(2)
  })

  it.each([
    // prose
    'and/or', 'read/write access', 'client/server', 'yes/no', 'w/o tests', 'n/a', 'I/O', 'CI/CD', 'UI/UX', 'A/B testing',
    '24/7', '50/50', 'km/h', 'MB/s', 'TCP/IP', 'either/or.', 'the read/write.Then we', 'e.g./i.e.', 'docs/ and specs/',
    // versions
    'v1.6/v1.7', '1.6.0/1.7.0', 'node/24.1.0', 'release/2.1', 'release/v1.6', 'python3.12/site-packages/x.py', 'library/node:24.1',
    // git refs, with or without a line
    'PRE-EXISTING on main (origin/main:238; this PR)', 'upstream/master:12', 'refs/heads/main:3', 'origin/main',
    // dates and times
    '2026/10/23', '10/23/2026', '23/10/2026.', 'on 2026-10-23/24', 'at 3/4:12',
    // code
    '`node:fs/promises`', '`@modelcontextprotocol/sdk/server/mcp.js`', '`zod/v4`', '`react-dom/client`', "import x from './links.js'",
    '`../src/store.ts`', 'src/../etc/passwd.md', 'docs/./x.md', 'docs//x.md', '`x/*.ts`', 'src/**/*.test.ts', '`text/html`',
    '`application/json`', '`application/vnd.api+json`', '`image/svg+xml`', '`foo/bar.baz()`', '`a/b.md#L12`', '`a/b.md?raw=1`',
    '`a.b/c.d`', '`this.state/props.x`', 'ms/1000.0', '`$HOME/x.md`', '`%APPDATA%/x.md`', 'C:/Users/s/x.md', '`~user/x.md`',
    '/\\d+/g.test(x)', 'docs/x.md_', '_docs/x.md_', './Dockerfile:3', "require('./links.js')",
    // an elision stands for folders left out
    'oris-engine-src/.../ImportDelivery.swift:247', 'src/…/x.ts',
    // URLs and hosts without a scheme
    'github.com/shariqh/agent-inbox/blob/main/docs/x.md', 'docs.python.org/3/library/os.html', 'example.com/guide.html',
    'localhost:4319/x.md', 'user@host.com/x.md',
    // folders, names with no folder, globs
    'docs/', 'docs/specs/', 'README.md', 'CLAUDE.md', 'Makefile:12', 'docs/*.md', '.md/.markdown', '.../x.md',
    // glued to a neighbour, or quoted as something else
    'see:docs/x.md', '**docs/x.md**', '<docs/x.md>', 'x/docs/../a.md',
    // a path that went on across a space: never its second half
    '/Users/s/My Documents/a.md', '~/My Notes/x.md', 'docs/My Notes.md', 'docs/My Folder/notes.md',
    // an ellipsis stands for what was left out
    'docs/superpowers/specs/….md', '…/specs/x.md',
  ])('leaves %j plain', (text) => {
    expect(rel(text)).toEqual([])
  })

  it('leaves owner/name#N to the references, and every other kind where it was', () => {
    expect(rel('shariqh/agent-inbox#324 and vercel/next.js#123')).toEqual([
      ['issue', 'shariqh/agent-inbox#324', 'https://github.com/shariqh/agent-inbox/issues/324'],
      ['issue', 'vercel/next.js#123', 'https://github.com/vercel/next.js/issues/123'],
    ])
    expect(rel('See /Users/s/a.md, docs/b.md, #301 and ~/c.md, then docs/d.md docs/e.md')).toEqual([
      ['file', '/Users/s/a.md', '/Users/s/a.md'],
      ['file', 'docs/b.md', 'docs/b.md'],
      ['issue', '#301', 'https://github.com/shariqh/agent-inbox/issues/301'],
      ['file', '~/c.md', '~/c.md'],
      ['file', 'docs/d.md', 'docs/d.md'],
      ['file', 'docs/e.md', 'docs/e.md'],
    ])
    const [absolute] = findPlainLinks('/Users/s/a.md', 0, 13, { root: ROOT })
    expect(absolute).not.toHaveProperty('root')
  })

  it('renders one as an inert control carrying its path and folder, never an href, all escaped', () => {
    const root = '/Users/s/<b>"repo"'
    const text = 'Spec at docs/spec.md:12'
    const html = linkedHtml(text, 0, text.length, { root })
    expect(html).toBe('Spec at <a class="structured-link file-link" role="button" tabindex="0" data-link-kind="file" data-link-path="docs/spec.md"' +
      ' data-link-root="/Users/s/&lt;b&gt;&quot;repo&quot;" title="/Users/s/&lt;b&gt;&quot;repo&quot;/docs/spec.md:12">docs/spec.md:12</a>')
    expect(linkedHtml(text, 0, text.length, { root: ROOT, copyFiles: true })).toContain(`title="Copy path: ${ROOT}/docs/spec.md"`)
    expect(renderStructuredText('```\ncat docs/spec.md\n```\n\nThen docs/next.md', { root: ROOT })).not.toContain('data-link-path="docs/spec.md"')
  })

  it('stays linear on hostile relative candidates', () => {
    const hostile = [
      `${'a/'.repeat(60_000)}x.md`,
      'a/b '.repeat(60_000),
      'x/y.md#'.repeat(30_000),
      `${'a'.repeat(200)}/`.repeat(2_000),
      'z/ '.repeat(60_000),
    ].join('\n')
    const started = performance.now()
    const html = renderStructuredText(`${hostile}\nSee docs/ok.md`, { repo: REPO, root: ROOT })
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(html).toContain('data-link-path="docs/ok.md"')
  }, 10_000)
})
