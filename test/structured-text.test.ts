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

  it('ignores greater-than characters inside quoted tag attributes', () => {
    const html = renderStructuredText(
      '<a title=">" href="https://attribute.example/x">label</a> then https://prose.example/x',
    )
    expect(html).toContain('&lt;a title=&quot;&gt;&quot; href=&quot;https://attribute.example/x&quot;&gt;')
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('also ignores greater-than characters inside single-quoted tag attributes', () => {
    const html = renderStructuredText(
      "<a title='>' href='https://attribute.example/x'>label</a> then https://prose.example/x",
    )
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('tracks quoted tag attributes across line breaks until an unquoted close', () => {
    const html = renderStructuredText(
      '<a title="\n> still quoted" href="https://attribute.example/x">label</a>\nhttps://prose.example/x',
    )
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('keeps line-leading custom tags and real attributes inert', () => {
    const html = renderStructuredText(
      '<custom-widget\nhref="https://attribute.example/x">label</custom-widget>\nhttps://prose.example/x',
    )
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('keeps boolean-first and framework-style attributes inert', () => {
    for (const fragment of [
      '<iframe allowfullscreen src="https://attribute.example/x" />',
      '<a @click="https://attribute.example/x">label</a>',
      '<a on:click|once="https://attribute.example/x">label</a>',
      '<custom-widget ...props data-url="https://attribute.example/x" />',
    ]) {
      const html = renderStructuredText(`before ${fragment} after https://prose.example/x`)
      expect(html).not.toContain('href="https://attribute.example/x"')
      expect(html).toContain('href="https://prose.example/x"')
    }
  })

  it('keeps recognized multiline tags inert after a boolean attribute', () => {
    const html = renderStructuredText(
      'before <iframe allowfullscreen\nsrc="https://attribute.example/x">label</iframe>\nafter https://prose.example/x',
    )
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it.each([
    '<Component onClick={() => open("https://attribute.example/x")} href="https://attribute.example/y">',
    '<Component when={value >= limit ? "https://attribute.example/x" : fallback}>',
    '<Component bits={value >> 2} href="https://attribute.example/x">',
    '<Component render={({items: [first]}) => first > 0 ? "https://attribute.example/x" : null}>',
    '<Component render={() => factory<Map<string, Array<number>>>("https://attribute.example/x")}>',
    '<Component render={({items:\n[first]}) => first > 0 ? "https://attribute.example/x" : null}>',
    '<Component message={"say \\" > https://attribute.example/x"} href="https://attribute.example/y">',
    '<Component when={/* } */ value > 0 ? "https://attribute.example/x" : fallback}>',
    '<Component when={/}/.test(value) && value > 0 ? "https://attribute.example/x" : fallback}>',
    '<Component a={1} when={/}/.test(value) && value > 0 ? "https://attribute.example/x" : fallback}>',
    '<Component when={value // }\n> 0 ? "https://attribute.example/x" : fallback}>',
    '<Component when={/}}/.test(value) && value / 2 > 0 ? "https://attribute.example/x" : fallback}>',
    '<Component text={`outer ${value > 0 ? `inner ${"https://attribute.example/x"}` : ""}`} href="https://attribute.example/y">',
  ])('keeps greater-than operators inside JSX expressions inert: %s', (fragment) => {
    const html = renderStructuredText(`before ${fragment}label</Component>\nafter https://prose.example/x`)
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).not.toContain('href="https://attribute.example/y"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('keeps line-leading PascalCase components inert across boolean-first attributes', () => {
    const html = renderStructuredText(
      '<Component disabled\nhref="https://attribute.example/x">label</Component>\nhttps://prose.example/x',
    )
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('keeps quoted component attributes inert across blank lines', () => {
    const html = renderStructuredText(
      '<Component href="\n\nhttps://attribute.example/x">label</Component>\nhttps://prose.example/x',
    )
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('keeps top-level TSX component generics inert', () => {
    const html = renderStructuredText(
      '<Component<Array<Map<string, number>>> href="https://attribute.example/x">label</Component>\nhttps://prose.example/x',
    )
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('does not close TSX generics on function arrows', () => {
    const html = renderStructuredText(
      '<Component<() => Promise<Map<string, number>>> href="https://attribute.example/x">label</Component>\nhttps://prose.example/x',
    )
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it.each([
    '<Component<typeof (a > b)> href="https://attribute.example/x">',
    '<Component<() => { value: a > b }> href="https://attribute.example/x">',
    '<Component<a >= b> href="https://attribute.example/x">',
    '<Component<"\\\\\\">"> href="https://attribute.example/x">',
  ])('keeps structured and quoted generic content inert: %s', (fragment) => {
    const html = renderStructuredText(`${fragment}label</Component>\nhttps://prose.example/x`)
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it.each([
    'before <Component disabled\nhref="https://attribute.example/x">label</Component>',
    '<UI.Component disabled\nhref="https://attribute.example/x">label</UI.Component>',
    'before <UI.Component disabled\nhref="https://attribute.example/x">label</UI.Component>',
  ])('keeps inline and member framework components inert: %s', (fragment) => {
    const html = renderStructuredText(`${fragment}\nhttps://prose.example/x`)
    expect(html).not.toContain('href="https://attribute.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('keeps comment content inert until an exact comment close', () => {
    const html = renderStructuredText(
      '<!-- > https://comment.example/x --> then https://prose.example/x',
    )
    expect(html).not.toContain('href="https://comment.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('ignores quotes inside comments and tracks the comment across lines', () => {
    const html = renderStructuredText(
      '<!-- "quoted >\nhttps://comment.example/x\n--> See https://prose.example/x',
    )
    expect(html).not.toContain('href="https://comment.example/x"')
    expect(html).toContain('href="https://prose.example/x"')
  })

  it('does not mistake a plain less-than comparison for a cross-line HTML tag', () => {
    const html = renderStructuredText('threshold < 5\nsee https://example.com/path')
    expect(html).toContain('threshold &lt; 5')
    expect(html).toContain('href="https://example.com/path"')
  })

  it('does not let a compact comparison suppress following links or lists', () => {
    const html = renderStructuredText('x<y\nSee https://example.com/path\n- item')
    expect(html).toContain('x&lt;y')
    expect(html).toContain('href="https://example.com/path"')
    expect(html).toContain('<ul><li>item</li></ul>')
  })

  it.each([
    'x<y and z',
    'is x <y ',
    'is x <a',
    'if x<y = z',
    'if x<y and z = t',
    'if (x<y && a === z)',
    'if (x<y || a !== z)',
    'if (x<y <= a)',
    'if (x<y >= a)',
    'x<Y and z',
    'if x<UI.Component and z',
    'if (x <threshold )',
    'x <max-size ',
  ])('does not treat a compact comparison as a tag: %s', (comparison) => {
    const html = renderStructuredText(`${comparison}\nSee https://example.com/path\n- item`)
    expect(html).toContain('href="https://example.com/path"')
    expect(html).toContain('<ul><li>item</li></ul>')
  })

  it('does not use a quoted greater-than to validate a compact comparison', () => {
    const html = renderStructuredText('if x<y, print(">")\nSee https://example.com/path\n- item')
    expect(html).toContain('href="https://example.com/path"')
    expect(html).toContain('<ul><li>item</li></ul>')
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

  it('uses delimiter order rather than aggregate counts', () => {
    const url = 'https://example.com/)(foo)'
    const html = renderStructuredText(url)
    expect(html).toContain(`href="${url}"`)
    expect(html).toContain(`${url}</a>`)
  })

  it('keeps a sentence-ending question mark outside a URL that has a query', () => {
    const html = renderStructuredText('Open https://example.com/search?q=renderer?')
    expect(html).toContain('href="https://example.com/search?q=renderer"')
    expect(html).toContain('q=renderer</a>?</p>')
  })

  it.each([
    'https://example.com/search?q=)',
    'https://example.com/path#fragment]',
  ])('preserves unmatched delimiters that are data in a query or fragment: %s', (url) => {
    const html = renderStructuredText(url)
    expect(html).toContain(`href="${url}"`)
    expect(html).toContain(`${url}</a>`)
  })

  it('keeps a prose wrapper outside a URL with a query', () => {
    const html = renderStructuredText('(see https://example.com/?q=1)')
    expect(html).toContain('href="https://example.com/?q=1"')
    expect(html).toContain('q=1</a>)</p>')
  })

  it('tracks nested prose wrappers in their actual closing order', () => {
    const html = renderStructuredText('([see https://example.com/?q=])')
    expect(html).toContain('href="https://example.com/?q="')
    expect(html).toContain('q=</a>])</p>')
  })

  it('trims one external wrapper while preserving same-character query data', () => {
    const html = renderStructuredText('(see https://example.com/?q=))')
    expect(html).toContain('href="https://example.com/?q=)"')
    expect(html).toContain('q=)</a>)</p>')
  })

  it('applies an external wrapper to the final adjacent URL without leaking state', () => {
    const html = renderStructuredText(
      '(https://a.example/x,https://b.example/y) x https://c.example/z?q=)',
    )
    expect(html).toContain('href="https://a.example/x"')
    expect(html).toContain('href="https://b.example/y"')
    expect(html).toContain('href="https://c.example/z?q=)"')
    expect(html.match(/<a /g)).toHaveLength(3)
  })

  it('maintains prose wrapper state across an inert entity fragment', () => {
    const html = renderStructuredText('(see &amp; https://example.com/?q=)')
    expect(html).toContain('href="https://example.com/?q="')
    expect(html).toContain('q=</a>)</p>')
  })

  it('maintains prose wrapper state across explicit paragraph line breaks', () => {
    const html = renderStructuredText('(see\nhttps://example.com/?q=)')
    expect(html).toContain('href="https://example.com/?q="')
    expect(html).toContain('<br><a ')
    expect(html).toContain('q=</a>)</p>')
  })

  it('tracks nested wrappers across lines and multiple URLs', () => {
    const html = renderStructuredText(
      '([see\nhttps://one.example/x and https://two.example/x?q=])',
    )
    expect(html).toContain('href="https://one.example/x"')
    expect(html).toContain('href="https://two.example/x?q="')
    expect(html).toContain('q=</a>])</p>')
  })

  it.each([
    '(see\n\nhttps://example.com/?q=)',
    '(see\n- https://example.com/?q=)',
  ])('resets prose wrapper state at paragraph and list boundaries: %s', (value) => {
    const html = renderStructuredText(value)
    expect(html).toContain('href="https://example.com/?q=)"')
  })

  it.each([
    ['…', 'ellipsis'],
    ['。', 'ideographic full stop'],
    ['！', 'full-width exclamation'],
    ['”', 'closing double quote'],
    ['）', 'full-width closing parenthesis'],
    ['؟', 'Arabic question mark'],
    ['،', 'Arabic comma'],
    ['»', 'closing guillemet'],
  ])('keeps Unicode %s outside the URL', (punctuation) => {
    const html = renderStructuredText(`Open https://example.com/path${punctuation}`)
    expect(html).toContain('href="https://example.com/path"')
    expect(html).toContain(`path</a>${punctuation}</p>`)
  })

  it('recognizes an opening guillemet as a safe prose boundary', () => {
    const html = renderStructuredText('«https://example.com/path»')
    expect(html).toContain('href="https://example.com/path"')
    expect(html).toContain('«<a ')
  })

  it.each([
    'https://example.com/search?q=مرحبا،العالم',
    'https://example.com/مرحبا،العالم?q=1',
    'https://example.com/path/%D8%9F?q=%C2%ABvalue%C2%BB',
  ])('retains Unicode or encoded punctuation inside URL data: %s', (url) => {
    const html = renderStructuredText(url)
    expect(html).toContain(`>${url}</a>`)
    expect(html.match(/<a /g)).toHaveLength(1)
  })

  it.each([',', ';', '，', '；'])('splits adjacent HTTP(S) URLs after %s', (separator) => {
    const html = renderStructuredText(`https://a.example/x${separator}https://b.example/y`)
    expect(html).toContain('href="https://a.example/x"')
    expect(html).toContain('href="https://b.example/y"')
    expect(html.match(/<a /g)).toHaveLength(2)
  })

  it.each([
    'https://example.com/path?next=a,https://nested.example/x',
    'https://example.com/path#next=a;https://nested.example/x',
  ])('preserves embedded URLs inside a query or fragment: %s', (url) => {
    const html = renderStructuredText(url)
    expect(html).toContain(`href="${url}"`)
    expect(html.match(/<a /g)).toHaveLength(1)
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

  it('keeps entity-like query substrings inside one URL candidate', () => {
    const html = renderStructuredText('See https://example.com/path?a=1&amp;b=2 and &amp; alone')
    expect(html).toContain('href="https://example.com/path?a=1&amp;amp;b=2"')
    expect(html).toContain('>https://example.com/path?a=1&amp;amp;b=2</a>')
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html).toContain('and &amp;amp; alone')
  })
})

describe('structured text presentation contract', () => {
  it('pins wrapping in source because jsdom cannot prove long-content layout', () => {
    const css = readFileSync(join(REPO, 'public/style.css'), 'utf8')
    expect(css).toMatch(/\.structured-text\s*\{[^}]*overflow-wrap:\s*anywhere;/)
    expect(css).toMatch(/\.structured-link\s*\{[^}]*overflow-wrap:\s*anywhere;/)
  })

  it('uses one backward offset pass instead of rescanning and slicing trailing delimiters', () => {
    const source = readFileSync(join(REPO, 'public/structured-text.js'), 'utf8')
    const start = source.indexOf('function splitTrailingPunctuation(')
    const fn = source.slice(start, source.indexOf('\nfunction renderLinkedSegment(', start))
    expect(fn).not.toContain('countChar(')
    const loop = fn.slice(fn.indexOf('while ('), fn.indexOf('\n  return '))
    expect(loop).not.toContain('.slice(')
    expect(fn).toContain('new Uint8Array(candidate.length)')
  })

  it('assesses tag credibility without rescanning line prefixes or suffixes', () => {
    const source = readFileSync(join(REPO, 'public/structured-text.js'), 'utf8')
    expect(source).not.toContain("remainder.includes('>')")
    expect(source).not.toContain('value.slice(0, match.index).trim()')
    expect(source).toContain("allowGenerics && char === '<' && index === start")
  })
})
