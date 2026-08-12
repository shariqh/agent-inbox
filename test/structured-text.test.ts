import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

describe('renderStructuredText escaping', () => {
  it.each([
    '<img src=x onerror="alert(1)">',
    '<script>javascript:alert(1)</script>',
    '&amp; &#60; &fake;',
    'quotes "double" and \'single\'',
  ])('renders hostile or entity-like input literally: %s', (input) => {
    const html = renderStructuredText(input)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain(' onerror="')
    expect(html).not.toContain(input)
  })

  it('does not autolink URLs inside HTML-like source while linking following prose', () => {
    const html = renderStructuredText(
      '<a href="https://attribute.example/x">label</a> then https://prose.example/x',
    )
    expect(html).toContain('&lt;a href=&quot;https://attribute.example/x&quot;&gt;')
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('keeps an unclosed HTML-like fragment inert too', () => {
    const html = renderStructuredText('<a href="https://attribute.example/x')
    expect(html).toContain('&lt;a href=&quot;https://attribute.example/x')
    expect(html).not.toContain('<a ')
  })

  it('keeps URLs in HTML-like tag fragments inert across line breaks', () => {
    const html = renderStructuredText('<a\nhref="https://attribute.example/x">label</a>')
    expect(html).toContain('&lt;a<br>href=&quot;https://attribute.example/x&quot;&gt;')
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).not.toContain('<a ')
  })

  it('does not mistake a plain less-than comparison for a cross-line HTML tag', () => {
    const html = renderStructuredText('threshold < 5\nsee https://example.com/path')
    expect(html).toContain('threshold &lt; 5')
    expect(html).toContain('href="https://example.com/path"')
  })
})

describe('renderStructuredText safe autolinks', () => {
  it('links multiple mid-sentence http/https URLs with queries and fragments', () => {
    const html = renderStructuredText(
      'Read https://example.com/docs?q=a&b=c#part, then (http://localhost:4319/x).',
    )
    expect(html).toContain(
      '<a href="https://example.com/docs?q=a&amp;b=c#part" target="_blank" rel="noopener noreferrer" class="structured-link">' +
      'https://example.com/docs?q=a&amp;b=c#part</a>,',
    )
    expect(html).toContain(
      '(<a href="http://localhost:4319/x" target="_blank" rel="noopener noreferrer" class="structured-link">' +
      'http://localhost:4319/x</a>).',
    )
    expect(html.match(/<a /g)).toHaveLength(2)
  })

  it.each([
    ['https://example.com/a.', 'https://example.com/a', '.'],
    ['https://example.com/a,', 'https://example.com/a', ','],
    ['https://example.com/a!', 'https://example.com/a', '!'],
    ['https://example.com/a;', 'https://example.com/a', ';'],
    ['https://example.com/a:', 'https://example.com/a', ':'],
    ['https://example.com/a)', 'https://example.com/a', ')'],
    ['https://example.com/a]', 'https://example.com/a', ']'],
    ['https://example.com/a}', 'https://example.com/a', '}'],
  ])('keeps trailing prose punctuation outside %s', (source, href, trailing) => {
    const html = renderStructuredText(source)
    expect(html).toContain(`href="${href}"`)
    expect(html).toContain(`</a>${trailing}</p>`)
  })

  it('keeps balanced parentheses that belong to the URL', () => {
    const html = renderStructuredText('See https://example.com/wiki/Foo_(bar).')
    expect(html).toContain('href="https://example.com/wiki/Foo_(bar)"')
    expect(html).toContain('Foo_(bar)</a>.</p>')
  })

  it('keeps a sentence-ending question mark outside a URL that has a query', () => {
    const html = renderStructuredText('Open https://example.com/search?q=renderer?')
    expect(html).toContain('href="https://example.com/search?q=renderer"')
    expect(html).toContain('q=renderer</a>?</p>')
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

  it('runs candidate URLs through the URL parser rather than trusting regex shape', () => {
    const html = renderStructuredText('HTTP://EXAMPLE.COM/a')
    expect(html).toContain('href="http://example.com/a"')
    expect(html).toContain('>HTTP://EXAMPLE.COM/a</a>')
  })
})

describe('structured text presentation contract', () => {
  it('pins wrapping in source because jsdom cannot prove long-content layout', () => {
    const css = readFileSync(join(REPO, 'public/style.css'), 'utf8')
    expect(css).toMatch(/\.structured-text\s*\{[^}]*overflow-wrap:\s*anywhere;/)
    expect(css).toMatch(/\.structured-link\s*\{[^}]*overflow-wrap:\s*anywhere;/)
  })
})
