// The GitHub Pages site for the extension URIs (publishable-agent design §6, D22; #537): every
// `docs/ext/<name>-v<N>.md` becomes `ext/<name>/v<N>.html`, which Pages serves at the
// extension-less URI `https://shariqh.github.io/agent-inbox/ext/<name>/v<N>` with no redirect,
// and `ext/<name>/v<N>/index.html` for the same URI with a trailing slash; `index.html` lists
// them. Nothing else in `docs/` is read or published. Node core only, no dependency: the
// Markdown subset the specs use (headings, paragraphs, `-` lists, tables, fenced code, inline
// code, bold and https links) is all it renders, and every character of the source is escaped.
//
//   node scripts/pages-site.mjs <out-dir>    writes the site into a new or empty directory
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://shariqh.github.io/agent-inbox/'
const SPEC = /^([a-z0-9]+(?:-[a-z0-9]+)*)-v([1-9][0-9]*)\.md$/

const esc = (text) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

// code spans first, so nothing inside them is read as bold or a link
function inline(text) {
  return text.split(/(`[^`]+`)/).map((part, i) => {
    if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`
    return esc(part)
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  }).join('')
}

const slug = (text) => text.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => inline(cell.trim()))

/** The HTML body for one spec's Markdown, and its first heading. */
export function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const html = []
  let title
  let i = 0
  const starts = (line) => /^(#{1,6} |```|- |\|)/.test(line)
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (line.startsWith('```')) {
      const body = []
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i])
      i++
      html.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      title ??= heading[2]
      html.push(`<h${level} id="${slug(heading[2])}">${inline(heading[2])}</h${level}>`)
      i++
      continue
    }
    if (line.startsWith('|') && /^\|[\s|:-]+\|$/.test(lines[i + 1] ?? '')) {
      const head = cells(line)
      const rows = []
      for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(cells(lines[i]))
      html.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    if (line.startsWith('- ')) {
      const items = []
      for (; i < lines.length && (lines[i].startsWith('- ') || /^ {2}\S/.test(lines[i])); i++) {
        if (lines[i].startsWith('- ')) items.push(lines[i].slice(2))
        else items[items.length - 1] += ` ${lines[i].trim()}`
      }
      html.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`)
      continue
    }
    const paragraph = [line.trim()]
    for (i++; i < lines.length && lines[i].trim() && !starts(lines[i]); i++) paragraph.push(lines[i].trim())
    html.push(`<p>${inline(paragraph.join(' '))}</p>`)
  }
  return { title: title ?? 'Specification', body: html.join('\n') }
}

const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${inline(title).replace(/<[^>]+>/g, '')}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; color: #1f2328; }
code, pre { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: #f6f8fa; }
pre { padding: 0.75rem; overflow-x: auto; }
table { border-collapse: collapse; } th, td { border: 1px solid #d0d7de; padding: 0.3rem 0.6rem; text-align: left; vertical-align: top; }
</style>
</head>
<body>
${body}
<hr>
<p>Published by <a href="https://github.com/shariqh/agent-inbox">agent-inbox</a> from <code>docs/ext/</code>.</p>
</body>
</html>
`

/**
 * The whole site, path to content, from `<root>/docs/ext/` alone. Throws on any entry there that
 * is not a regular file named `<name>-v<N>.md` (a symlink included), so nothing else is ever
 * published by mistake.
 */
export function buildSite(root) {
  const dir = join(root, 'docs', 'ext')
  const files = new Map()
  const specs = []
  const real = realpathSync(dir)
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const name = entry.name
    const match = SPEC.exec(name)
    if (!match) throw new Error(`docs/ext/${name} is not <name>-v<N>.md, and only extension specs are published`)
    // a symlink (or anything but a plain file) could publish a file from outside docs/ext
    if (!entry.isFile() || realpathSync(join(dir, name)) !== join(real, name)) throw new Error(`docs/ext/${name} is not a regular file in docs/ext, and only extension specs are published`)
    const { title, body } = renderMarkdown(readFileSync(join(dir, name), 'utf8'))
    const path = `ext/${match[1]}/v${match[2]}`
    files.set(`${path}.html`, page(title, body))
    files.set(`${path}/index.html`, page(title, body))
    specs.push({ title, path })
  }
  files.set('index.html', page('agent-inbox extensions', [
    '<h1>agent-inbox extensions</h1>',
    '<p>A2A extension specifications published by <a href="https://github.com/shariqh/agent-inbox">agent-inbox</a>. Each is served at its URI:</p>',
    `<ul>${specs.map((s) => `<li><a href="${s.path}">${inline(s.title)}</a>: <code>${esc(BASE + s.path)}</code></li>`).join('')}</ul>`,
  ].join('\n')))
  return files
}

/** Writes the site into `out`, which must be new or empty. */
export function writeSite(root, out) {
  mkdirSync(out, { recursive: true })
  if (readdirSync(out).length) throw new Error(`${out} is not empty`)
  for (const [path, content] of buildSite(root)) {
    mkdirSync(dirname(join(out, path)), { recursive: true })
    writeFileSync(join(out, path), content)
  }
}

const entry = process.argv[1]
let isMain = false
try {
  isMain = Boolean(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
} catch { /* not run directly */ }
if (isMain) {
  if (process.argv.length !== 3) {
    process.stderr.write('usage: node scripts/pages-site.mjs <out-dir>\n')
    process.exit(2)
  }
  writeSite(resolve(dirname(fileURLToPath(import.meta.url)), '..'), resolve(process.argv[2]))
}
