import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderStructuredText } from '../public/structured-text.js'

const REPO = new URL('..', import.meta.url).pathname

describe('renderStructuredText block structure', () => {
  it('preserves paragraphs, line breaks, and consecutive simple lists', () => {
    expect(renderStructuredText([
      'First line',
      'continued',
      '',
      '- alpha',
      '* beta',
      '',
      '1. first',
      '2. second',
    ].join('\n'))).toBe(
      '<div class="structured-text">' +
        '<p>First line<br>continued</p>' +
        '<ul><li>alpha</li><li>beta</li></ul>' +
        '<ol><li>first</li><li>second</li></ol>' +
      '</div>',
    )
  })

  it('keeps non-list markers and blank input as plain text or nothing', () => {
    expect(renderStructuredText('Version 1. ships\n-compact\n*also compact'))
      .toBe('<div class="structured-text"><p>Version 1. ships<br>-compact<br>*also compact</p></div>')
    expect(renderStructuredText('')).toBe('')
    expect(renderStructuredText(null)).toBe('')
  })
})

describe('renderStructuredText quarantine', () => {
  it.each([
    ['recognized HTML', '<a href="https://attribute.example/html">label</a>'],
    ['comment', '<!-- https://attribute.example/comment -->'],
    ['doctype', '<!DOCTYPE html> https://attribute.example/doctype'],
    ['closing tag', 'text </unknown> https://attribute.example/closing'],
    ['custom element', '<custom-widget data-url="https://attribute.example/custom">'],
    ['PascalCase component', '<Component href="https://attribute.example/component">'],
    ['member component', 'before <UI.Component href="https://attribute.example/member">'],
    ['lowercase member component', 'before <motion.div href="https://attribute.example/member-lower">'],
    ['Unicode component', '<组件 href="https://attribute.example/unicode">'],
    ['SVG element', '<svg href="https://attribute.example/svg">'],
  ])('quarantines the remainder of a block after %s', (_name, fragment) => {
    const html = renderStructuredText(`${fragment}\nhttps://prose.example/inert`)
    expect(html).not.toContain('<a ')
    expect(html).toContain('https://prose.example/inert')
  })

  it('autolinks the prefix before a credible start and quarantines the suffix', () => {
    const html = renderStructuredText(
      'Read https://prose.example/before, then ' +
      '<a href="https://attribute.example/x">raw</a> and https://prose.example/after',
    )
    expect(html).toContain('href="https://prose.example/before"')
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).not.toContain('href="https://prose.example/after"')
  })

  it.each([
    'Markup: (<a href="https://attribute.example/wrapper">label</a>)',
    'const view=<Component href="https://attribute.example/assignment">label</Component>',
    'render([<Component href="https://attribute.example/bracket">label</Component>])',
  ])('accepts wrapper or JSX-introducing punctuation: %s', (value) => {
    expect(renderStructuredText(`${value} https://prose.example/inert`)).not.toContain('<a ')
  })

  it('carries quarantine across multiline attributes and malformed fragments', () => {
    const html = renderStructuredText([
      'Read https://prose.example/before',
      '<Component disabled',
      'render={() => "https://attribute.example/expression"}',
      'href="https://attribute.example/href"',
      'https://prose.example/inert',
    ].join('\n'))
    expect(html).toContain('href="https://prose.example/before"')
    expect(html).not.toContain('href="https://attribute.example/expression"')
    expect(html).not.toContain('href="https://attribute.example/href"')
    expect(html).not.toContain('href="https://prose.example/inert"')
  })

  it('fails closed for a recognized malformed tag through block end', () => {
    const html = renderStructuredText(
      'prefix <a https://attribute.example/malformed tail',
    )
    expect(html).not.toContain('<a ')
    expect(html).toContain('https://attribute.example/malformed')
  })

  it('does not let a nested comparison cancel malformed-tag quarantine', () => {
    const html = renderStructuredText(
      'prefix <a href https://attribute.example/malformed ' +
      'x<Y https://prose.example/after',
    )
    expect(html).not.toContain('<a ')
    expect(html).toContain('https://attribute.example/malformed')
    expect(html).toContain('https://prose.example/after')
  })

  it('does not let an ambiguous quoted candidate hide a later tag start', () => {
    const html = renderStructuredText(
      'x<Y "unterminated <a href="https://attribute.example/x"> after',
    )
    expect(html).not.toContain('<a ')
    expect(html).toContain('https://attribute.example/x')
  })

  it('treats a framework expression attribute as obvious tag evidence', () => {
    const html = renderStructuredText(
      'before <Component {...(x<y?foo:bar)} ' +
      'href="https://attribute.example/x">label</Component> after',
    )
    expect(html).not.toContain('<a ')
    expect(html).toContain('https://attribute.example/x')
  })

  it('resets quarantine only at paragraph and list-item boundaries', () => {
    const html = renderStructuredText([
      '<Component href="https://attribute.example/x">',
      'https://prose.example/same-paragraph',
      '',
      'https://prose.example/next-paragraph',
      '',
      '- <custom-widget href="https://attribute.example/list"> https://prose.example/same-item',
      '- https://prose.example/next-item',
    ].join('\n'))
    expect(html).not.toContain('href="https://prose.example/same-paragraph"')
    expect(html).toContain('href="https://prose.example/next-paragraph"')
    expect(html).not.toContain('href="https://prose.example/same-item"')
    expect(html).toContain('href="https://prose.example/next-item"')
  })

  it.each([
    'x<Y',
    'x < Y',
    'if x<motion.div',
    'if (x<y && a === z)',
    'threshold < 5',
  ])('does not quarantine an ordinary comparison: %s', (comparison) => {
    const html = renderStructuredText(`${comparison}\nSee https://prose.example/x`)
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('escapes all quarantined source without emitting raw HTML', () => {
    const html = renderStructuredText(
      '<script>javascript:alert(1)</script>\n' +
      '<img src=x onerror="alert(2)">\n' +
      '&amp; &#60; &fake;',
    )
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain(' onerror="')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;amp;')
  })
})

describe('renderStructuredText safe autolinks', () => {
  it('links multiple mid-sentence HTTP(S) URLs with queries and fragments', () => {
    const html = renderStructuredText(
      'Read https://example.com/docs?q=a&b=c#part, then (http://localhost:4319/x).',
    )
    expect(html).toContain('href="https://example.com/docs?q=a&amp;b=c#part"')
    expect(html).toContain('href="http://localhost:4319/x"')
    expect(html.match(/<a /g)).toHaveLength(2)
  })

  it.each([
    ['https://example.com/a.', 'https://example.com/a', '.'],
    ['https://example.com/a,', 'https://example.com/a', ','],
    ['https://example.com/a!', 'https://example.com/a', '!'],
    ['https://example.com/a)', 'https://example.com/a', ')'],
    ['https://example.com/a]', 'https://example.com/a', ']'],
    ['https://example.com/a}', 'https://example.com/a', '}'],
  ])('keeps trailing prose punctuation outside %s', (source, href, trailing) => {
    const html = renderStructuredText(source)
    expect(html).toContain(`href="${href}"`)
    expect(html).toContain(`</a>${trailing}</p>`)
  })

  it('preserves balanced URL delimiters and external prose wrappers', () => {
    const balanced = renderStructuredText('See https://example.com/wiki/Foo_(bar).')
    expect(balanced).toContain('href="https://example.com/wiki/Foo_(bar)"')

    const wrapped = renderStructuredText('([see\nhttps://example.com/?q=])')
    expect(wrapped).toContain('href="https://example.com/?q="')
    expect(wrapped).toContain('q=</a>])</p>')
  })

  it.each([
    ['…', 'ellipsis'],
    ['؟', 'Arabic question mark'],
    ['،', 'Arabic comma'],
    ['»', 'closing guillemet'],
  ])('keeps Unicode %s outside the URL', (punctuation) => {
    const html = renderStructuredText(`Open https://example.com/path${punctuation}`)
    expect(html).toContain('href="https://example.com/path"')
    expect(html).toContain(`path</a>${punctuation}</p>`)
  })

  it('keeps entity-like query text inside one URL while escaping standalone entities', () => {
    const html = renderStructuredText('See https://example.com/path?a=1&amp;b=2 and &amp; alone')
    expect(html).toContain('href="https://example.com/path?a=1&amp;amp;b=2"')
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html).toContain('and &amp;amp; alone')
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    '//evil.example/x',
    'https://',
    'javascript:https://safe-looking.example/x',
    'wordhttps://embedded.example/x',
  ])('leaves unsupported, malformed, or deceptive input inert: %s', (input) => {
    expect(renderStructuredText(input)).not.toContain('<a ')
  })
})

describe('structured text quarantine architecture', () => {
  it('contains no JS/TS lexer state or scan-budget machinery', () => {
    const source = readFileSync(join(REPO, 'public/structured-text.js'), 'utf8')
    for (const forbidden of [
      'scanTag',
      'expressionClosers',
      'expressionContexts',
      'canStartRegex',
      'pendingControlHeader',
      'pendingClassKind',
      'genericClosers',
      'scanBudget',
      'REGEX_PREFIX_KEYWORDS',
    ]) {
      expect(source).not.toContain(forbidden)
    }
    expect(source.split('\n').length).toBeLessThan(350)
  })

  it('keeps hostile 50k-candidate input linear and isolated between renders', () => {
    const hostile = `${'x<Y '.repeat(50_000)}\nSee https://prose.example/x`
    const started = performance.now()
    const html = renderStructuredText(hostile)
    expect(performance.now() - started).toBeLessThan(100)
    expect(html).toContain('href="https://prose.example/x"')

    expect(renderStructuredText('<Component href="https://attribute.example/x">\nhttps://inert.example/x'))
      .not.toContain('<a ')
    expect(renderStructuredText('See https://fresh.example/x'))
      .toContain('href="https://fresh.example/x"')
  }, 10_000)

  it('pins wrapping in source because jsdom cannot prove long-content layout', () => {
    const css = readFileSync(join(REPO, 'public/style.css'), 'utf8')
    expect(css).toMatch(/\.structured-text\s*\{[^}]*overflow-wrap:\s*anywhere;/)
    expect(css).toMatch(/\.structured-link\s*\{[^}]*overflow-wrap:\s*anywhere;/)
  })
})
