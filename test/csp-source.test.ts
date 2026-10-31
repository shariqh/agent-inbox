// #412: the viewer's CSP is `script-src 'self'`, so the page may run only script files
// from its own origin. jsdom does not enforce CSP, so a DOM test would pass on code the
// real renderer refuses. This guard reads the shipped frontend instead and fails on
// the constructs that policy blocks: inline handler attributes, `javascript:` URLs,
// eval and its kin, and dynamic imports of anything but a same-origin module path.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PUBLIC = join(process.cwd(), 'public')

// Full-line `//` comments and `/* … */` blocks that start a line. Prose there may
// name what it guards against; code never starts a line that way.
function stripComments(source: string): string {
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

const RULES: Array<[string, RegExp]> = [
  // An `on…=` attribute inside markup a string builds: `<button onclick="…">`.
  ['inline event-handler attribute', /<[a-zA-Z][\w-]*\b[^<>]*?\son[a-z]+\s*=/],
  ['setAttribute of an event handler', /setAttribute\(\s*['"`]on[a-z]+['"`]/i],
  ['javascript: URL', /['"`(=]\s*javascript:/i],
  ['eval', /(^|[^\w.$])eval\s*\(/],
  ['Function constructor', /(^|[^\w.$])(new\s+)?Function\s*\(/],
  ['string timer', /\bset(Timeout|Interval)\s*\(\s*['"`]/],
  ['dynamic import of a non-module path', /\bimport\s*\((?!\s*['"`]\/[\w.-]+\.js['"`]\s*\))/],
  ['inline <script>', /<script\b/i],
]

function violations(source: string): string[] {
  const code = stripComments(source)
  return RULES.filter(([, pattern]) => pattern.test(code)).map(([name]) => name)
}

describe('frontend source under script-src \'self\'', () => {
  it('catches each construct the CSP blocks', () => {
    const samples: Array<[string, string]> = [
      ['inline event-handler attribute', 'el.innerHTML = `<button type="button"\n  onclick="go()">x</button>`'],
      ['setAttribute of an event handler', "el.setAttribute('onload', code)"],
      ['javascript: URL', "a.href = 'javascript:void 0'"],
      ['eval', 'const v = eval(text)'],
      ['Function constructor', "const f = new Function('a', body)"],
      ['Function constructor', "const f = Function('return 1')"],
      ['string timer', "setTimeout('tick()', 10)"],
      ['dynamic import of a non-module path', 'import(`data:text/javascript,${code}`)'],
      ['dynamic import of a non-module path', 'import(url)'],
      ['inline <script>', "host.innerHTML = '<script>x()</script>'"],
    ]
    for (const [name, sample] of samples) expect(violations(sample)).toContain(name)
    // What the frontend legitimately does stays clean.
    expect(violations([
      "import('/mesh-view.js')",
      'el.onclick = () => go()',
      "if (a < b && typeof f === 'function') isFunction(f)",
      'setTimeout(() => tick(), 10)',
      '// eval( and javascript: in a comment',
      "const html = `<button type=\"button\" data-on=\"x\">${esc(label)}</button>`",
    ].join('\n'))).toEqual([])
  })

  it.each(readdirSync(PUBLIC).filter((name) => name.endsWith('.js')))(
    'public/%s runs under the CSP',
    (name) => {
      expect(violations(readFileSync(join(PUBLIC, name), 'utf8'))).toEqual([])
    },
  )

  it('index.html loads every script from a same-origin file and has no handler attributes', () => {
    const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8')
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\ssrc="\/[\w.-]+\.js"/)
      expect(body!.trim()).toBe('')
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    expect(html).not.toMatch(/javascript:/i)
    expect(html).not.toMatch(/<(base|form|object|embed|iframe)\b/i)
  })
})
