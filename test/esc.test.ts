// test/esc.test.ts
import { describe, it, expect } from 'vitest'
import { esc } from '../public/esc.js'

describe('esc', () => {
  it('escapes all five HTML-significant characters: & < > " \'', () => {
    expect(esc('&')).toBe('&amp;')
    expect(esc('<')).toBe('&lt;')
    expect(esc('>')).toBe('&gt;')
    expect(esc('"')).toBe('&quot;')
    expect(esc("'")).toBe('&#39;')
  })

  it('escapes a mix of all five in one string, in order', () => {
    expect(esc(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('is a landmine-safe fixture for a single-quoted attribute (e.g. title=\'...\')', () => {
    const attacker = `x' onmouseover='alert(1)`
    const escaped = esc(attacker)
    expect(escaped).not.toContain("'")
    expect(escaped).toBe('x&#39; onmouseover=&#39;alert(1)')
  })

  it('leaves ordinary text untouched', () => {
    expect(esc('plain text 123')).toBe('plain text 123')
  })

  it('coerces non-string input via String()', () => {
    expect(esc(42)).toBe('42')
  })
})
