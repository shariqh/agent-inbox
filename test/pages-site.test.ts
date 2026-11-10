// The GitHub Pages site for the extension URIs (#537; publishable-agent design §6, D22): built from
// docs/ext/ alone, so it holds exactly the extension specs and the index, each spec at the path
// Pages serves for its extension-less URI, and the workflow that deploys it runs only on main.
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSite, renderMarkdown, writeSite } from '../scripts/pages-site.mjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = new URL('..', import.meta.url).pathname
const PROFILE = 'https://shariqh.github.io/agent-inbox/ext/profile/v1'

afterEach(() => removeScratchDirs())

const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile()).map((d) => relative(dir, join(d.parentPath, d.name))).sort()

describe('the extension specs site (#537)', () => {
  it('builds exactly the index and each spec at its extension-less path, from docs/ext alone', () => {
    expect(readdirSync(join(REPO, 'docs', 'ext'))).toEqual(['profile-v1.md'])
    const out = join(scratchDir('pages-'), '_site')
    writeSite(REPO, out)
    // Pages serves ext/profile/v1.html at …/ext/profile/v1 with no redirect, and the folder's index at …/v1/
    expect(files(out)).toEqual(['ext/profile/v1.html', 'ext/profile/v1/index.html', 'index.html'])
    const spec = readFileSync(join(out, 'ext/profile/v1.html'), 'utf8')
    expect(readFileSync(join(out, 'ext/profile/v1/index.html'), 'utf8')).toBe(spec)
    expect(spec).toContain('<title>Agent profile extension, version 1</title>')
    expect(spec).toContain(`<code>${PROFILE}</code>`)
    expect(spec).toMatch(/<h3 id="keys">keys<\/h3>/)
    expect(spec).toMatch(/<h4 id="residency">residency<\/h4>/)
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain(`<a href="ext/profile/v1">Agent profile extension, version 1</a>: <code>${PROFILE}</code>`)
    // the spec names the URI the code checks
    expect(readFileSync(join(REPO, 'src', 'agent-card.ts'), 'utf8')).toContain(`'${PROFILE}'`)
  })

  it('refuses any other file in docs/ext, and an output folder that is not empty', () => {
    const root = (...names: string[]): string => {
      const dir = scratchDir('pages-root-')
      mkdirSync(join(dir, 'docs', 'ext'), { recursive: true })
      for (const name of names) writeFileSync(join(dir, 'docs', 'ext', name), '# Thing\n')
      return dir
    }
    expect([...buildSite(root('thing-v2.md')).keys()].sort()).toEqual(['ext/thing/v2.html', 'ext/thing/v2/index.html', 'index.html'])
    for (const name of ['README.md', 'profile-v1.txt', 'Profile-v1.md', 'profile-v0.md', 'profile.md', '-v1.md']) {
      expect(() => buildSite(root('thing-v2.md', name)), name).toThrow('only extension specs are published')
    }
    // a symlink with a spec's name, to a file outside docs/ext (relative or absolute), or a folder, is refused
    const secret = join(scratchDir('pages-secret-'), 'secret.md')
    writeFileSync(secret, '# Secret\n')
    for (const target of [secret, '../../package.json', 'thing-v2.md']) {
      const dir = root('thing-v2.md')
      symlinkSync(target, join(dir, 'docs', 'ext', 'thing-v1.md'))
      expect(() => buildSite(dir), target).toThrow('docs/ext/thing-v1.md is not a regular file in docs/ext')
    }
    const folder = root()
    mkdirSync(join(folder, 'docs', 'ext', 'thing-v1.md'))
    expect(() => buildSite(folder)).toThrow('is not a regular file in docs/ext')
    const out = scratchDir('pages-out-')
    writeFileSync(join(out, 'stray'), '')
    expect(() => writeSite(REPO, out)).toThrow('is not empty')
  })

  it('renders the Markdown subset and escapes everything else', () => {
    const { title, body } = renderMarkdown([
      '# A <b>title</b>', '', 'Text with `<code>` and **bold** and [a link](https://example.org/x?a=1&b=2), [not](javascript:alert(1)).',
      'Second line <script>alert(1)</script>.', '', '- one', '  continued', '- two', '', '| A | B |', '|---|---|', '| `x` | y |', '',
      '```json', '{"a": "<b>"}', '```', '| not a table',
    ].join('\n'))
    expect(title).toBe('A <b>title</b>')
    expect(body).toBe([
      '<h1 id="a-b-title-b">A &#60;b&#62;title&#60;/b&#62;</h1>',
      '<p>Text with <code>&#60;code&#62;</code> and <strong>bold</strong> and <a href="https://example.org/x?a=1&#38;b=2">a link</a>, [not](javascript:alert(1)). Second line &#60;script&#62;alert(1)&#60;/script&#62;.</p>',
      '<ul><li>one continued</li><li>two</li></ul>',
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><code>x</code></td><td>y</td></tr></tbody></table>',
      '<pre><code>{&#34;a&#34;: &#34;&#60;b&#62;&#34;}</code></pre>',
      '<p>| not a table</p>',
    ].join('\n'))
  })
})

describe('the Pages workflow (#537)', () => {
  const workflow = readFileSync(join(REPO, '.github', 'workflows', 'pages.yml'), 'utf8')

  it('runs on main and by hand only, deploys only from main, with the least permissions', () => {
    expect(workflow).toContain('on:\n  push:\n    branches: [main]\n    paths:\n      - "docs/ext/**"\n      - "scripts/pages-site.mjs"\n      - ".github/workflows/pages.yml"\n  workflow_dispatch:\n')
    expect(workflow).not.toMatch(/pull_request/)
    expect(workflow).toContain('permissions:\n  contents: read\n')
    expect(workflow).toContain("    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n    permissions:\n      pages: write\n      id-token: write\n")
    expect(workflow.match(/pages: write/g)).toHaveLength(1)
    expect(workflow).toContain('      - run: node scripts/pages-site.mjs _site\n      - uses: actions/upload-pages-artifact@')
    expect(workflow).toMatch(/uses: actions\/deploy-pages@[0-9a-f]{40} # v\d+\.\d+\.\d+/)
    expect(workflow).not.toMatch(/^\s*(-\s+)?run:.*\bnpm\b/m)
  })
})
