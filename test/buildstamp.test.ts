// test/buildstamp.test.ts — issue #40, the sentence the human actually reads.
//
// The verdict comes from src/stamp.ts; this module turns it into ONE line in the
// Setup panel. It is pure (no DOM, no fetch) for the same reason public/attention.js
// is: the wording is the product, and every branch of it is cheap to pin here.
//
// Two things it must never do: claim staleness on the dev path, and be noisy when
// it has nothing to say.
import { describe, it, expect } from 'vitest'
import { buildSummary } from '../public/buildstamp.js'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const HEAD = '99887766554433221100ffeeddccbbaa99887766'
const AT = '2026-07-25T12:34:56.000Z'

describe('buildSummary · nothing to say renders nothing', () => {
  it('no stamp at all', () => {
    expect(buildSummary(null)).toBeNull()
    expect(buildSummary(undefined)).toBeNull()
  })

  it('a checkout with no readable HEAD (no git, not a repo)', () => {
    expect(buildSummary({ drift: 'dev', commit: null, builtAt: null, head: null, repoRoot: '/r' })).toBeNull()
  })

  it('a bundle packaged before #40 — no commit means no claim', () => {
    expect(buildSummary({ drift: 'unknown', commit: null, builtAt: null, head: null, repoRoot: '/r' })).toBeNull()
  })
})

describe('buildSummary · the dev path shows its live HEAD and never claims staleness', () => {
  const s = buildSummary({ drift: 'dev', commit: null, builtAt: null, head: HEAD, repoRoot: '/repo' })!

  it('names the checkout and the short HEAD', () => {
    expect(s.text).toContain('9988776')
    expect(s.text).toContain('/repo')
    expect(s.text.toLowerCase()).toContain('checkout')
  })

  it('offers no rebuild command and no warning', () => {
    expect(s.command).toBeNull()
    expect(s.tone).toBe('info')
    expect(s.text).not.toContain('package:app')
    expect(s.text.toLowerCase()).not.toContain('behind')
  })
})

describe('buildSummary · a packaged bundle', () => {
  const stamp = (drift: string, head = HEAD) =>
    buildSummary({ drift, commit: SHA, builtAt: AT, head, repoRoot: '/repo' })!

  it('current: answers "which build is this" and asks for nothing', () => {
    const s = stamp('current', SHA)
    expect(s.text).toContain('a1b2c3d')
    expect(s.text).toContain('2026-07-25 12:34 UTC')
    expect(s.command).toBeNull()
    expect(s.tone).toBe('info')
  })

  it('stale: warns, names both commits, and gives the exact command', () => {
    const s = stamp('stale')
    expect(s.tone).toBe('warn')
    expect(s.command).toBe('npm run package:app')
    expect(s.text).toContain('a1b2c3d')
    expect(s.text).toContain('9988776')
    expect(s.text).toContain('/repo')
    expect(s.text).toContain('⚠')
  })

  it('behind: the CHECKOUT moved back, so there is nothing to rebuild', () => {
    const s = stamp('behind')
    expect(s.tone, 'the app being newer than the checkout is not a warning').toBe('info')
    expect(s.command, 'repackaging would DOWNGRADE the app here').toBeNull()
    expect(s.text.toLowerCase()).toContain('newer')
    expect(s.text).toContain('9988776')
  })

  it('diverged: neither ahead nor behind — states it and offers the command', () => {
    const s = stamp('diverged')
    expect(s.tone).toBe('info')
    expect(s.command).toBe('npm run package:app')
    expect(s.text.toLowerCase()).not.toContain('behind its')
  })

  it('unknown: says which build it is and admits it could not compare', () => {
    const s = stamp('unknown', null as unknown as string)
    expect(s.text).toContain('a1b2c3d')
    expect(s.text).toContain('/repo')
    expect(s.command).toBeNull()
    expect(s.tone).toBe('info')
  })
})

describe('buildSummary · degraded fields never render as junk', () => {
  const junk = (text: string): void => {
    for (const bad of ['null', 'undefined', 'NaN', 'Invalid Date']) {
      expect(text, `rendered ${bad}`).not.toContain(bad)
    }
  }

  it('a missing builtAt drops the date instead of printing one', () => {
    const s = buildSummary({ drift: 'current', commit: SHA, builtAt: null, head: SHA, repoRoot: '/repo' })!
    expect(s.text).toContain('a1b2c3d')
    junk(s.text)
  })

  it('an unparseable builtAt is dropped too', () => {
    const s = buildSummary({ drift: 'stale', commit: SHA, builtAt: 'yesterday', head: HEAD, repoRoot: '/repo' })!
    junk(s.text)
  })

  it('a missing repoRoot still leaves a usable sentence', () => {
    const s = buildSummary({ drift: 'stale', commit: SHA, builtAt: AT, head: HEAD, repoRoot: null })!
    expect(s.text).toContain('a1b2c3d')
    junk(s.text)
  })

  it('an unknown drift value is treated as "nothing to say", never as a crash', () => {
    expect(buildSummary({ drift: 'sideways', commit: null, builtAt: null, head: null, repoRoot: null })).toBeNull()
  })
})
