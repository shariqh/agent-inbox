// Bench S12 (unslop-code, step 1): the bar every later version must pass, on the
// recorded answers of the owner's local model, so no model is needed here.
import { describe, expect, it } from 'vitest'
import { FIXTURES, SCOPE } from '../bench/s12/fixtures.js'
import { RECORDED } from '../bench/s12/recorded.js'
import { comments, score, scoreScope, summarize } from '../bench/s12/score.js'
import { commentLines } from '../src/code-slop.js'

describe('S12 fixtures', () => {
  it('are sound: every instance is in the given text and not in the original, and every original comment is given', () => {
    expect(FIXTURES).toHaveLength(15)
    expect(FIXTURES.filter((f) => f.seeded)).toHaveLength(10)
    for (const f of FIXTURES) {
      for (const i of f.instances) {
        expect(new RegExp(i.gone).test(f.given), `${f.id}: /${i.gone}/ given`).toBe(true)
        expect(new RegExp(i.gone).test(f.original), `${f.id}: /${i.gone}/ original`).toBe(false)
      }
      for (const comment of comments(f.original)) expect(f.given, `${f.id}: ${comment}`).toContain(comment)
      if (!f.seeded) expect(f.given, f.id).toBe(f.original)
      // the scanner reads every function, so no answer is dropped as unsure
      expect(commentLines(f.given, { jsx: f.ext !== '.ts' }).unsure, f.id).toBe(false)
    }
    expect(FIXTURES.flatMap((f) => f.instances).filter((i) => i.cat === 'comment')).toHaveLength(22)
    expect(FIXTURES.reduce((n, f) => n + comments(f.original).length, 0)).toBe(31)
    expect(Object.keys(RECORDED).sort()).toEqual(FIXTURES.map((f) => f.id).sort())
  })
})

describe('S12 bar on the recorded answers', () => {
  const s = score(FIXTURES, RECORDED)

  it('removes no good comment and at least 20 of the 22 slop comments, leaves the clean functions alone and keeps every program', () => {
    expect(s.good).toEqual({ removed: 0, total: 31 })
    expect(s.slop.total).toBe(22)
    expect(s.slop.removed).toBeGreaterThanOrEqual(20)
    expect(s.clean).toEqual({ identical: 5, total: 5 })
    expect(s.sameProgram).toEqual({ holds: 15, total: 15 })
    expect(summarize(s)).toContain('- Slop comments removed: 22 of 22.')
  })

  it('keeps each scope fixture\'s guarded comment, dropped with the right reason', () => {
    expect(SCOPE.map((f) => f.expect.dropped[0]!.why)).toEqual(['out-of-change', 'above-a-declaration', 'claimed-kept'])
    for (const f of SCOPE) expect(scoreScope(f), f.id).toEqual(f.expect)
  })

  it('counts a slop comment left and a good comment lost, so the bar can fail', () => {
    const bad = { ...RECORDED, 'find-age': { remove: '{"remove":[3]}', keep: '{"keep":[]}' }, stalled: { remove: '{"remove":[5]}', keep: '{"keep":[]}' } }
    const worse = score(FIXTURES, bad)
    expect(worse.slop.removed).toBe(19)
    expect(worse.good.removed).toBe(1)
    expect(worse.clean.identical).toBe(4)
    expect(summarize(worse)).toContain('- Good comments lost in stalled: // a blocked step not yet answered still asks, or waits where the person set it aside')
  })
})
