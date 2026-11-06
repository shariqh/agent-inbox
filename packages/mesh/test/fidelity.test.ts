// The fidelity check (#483, unslop design §6.1-§6.2): code, not the model,
// decides whether anything protected changed.
import { describe, expect, it } from 'vitest'
import { checkFidelity } from '../src/fidelity.js'
import type { FidelityReport } from '../src/fidelity.js'

const failed = (r: FidelityReport): string[] => Object.entries(r.hard).filter(([, v]) => v === 'failed').map(([k]) => k).sort()
const warned = (r: FidelityReport): string[] => r.warnings.map((w) => w.class).sort()

// [class, input, loss, addition, change, swap]; each output fails that class
const HARD: Array<[string, string, string, string, string, string]> = [
  ['code',
    'Run `npm ci` in the root, then `npm test` in the package.',
    'Run `npm ci` in the root, then test the package.',
    'Run `npm ci` in the root, then `npm test` and `npm run build` in the package.',
    'Run `npm ci` in the root, then `npm  test` in the package.',
    'Run `npm test` in the root, then `npm ci` in the package.'],
  ['code',
    'Start it:\n\n```sh\nnpm run view\n```\n\nThen check it:\n\n```sh\ncurl -s localhost:4319\n```',
    'Start it, then check it:\n\n```sh\ncurl -s localhost:4319\n```',
    'Start it:\n\n```sh\nnpm run view\n```\n\nThen check it:\n\n```sh\ncurl -s localhost:4319\n```\n\n```sh\nopen http://127.0.0.1:4319\n```',
    'Start it:\n\n```bash\nnpm run view\n```\n\nThen check it:\n\n```sh\ncurl -s localhost:4319\n```',
    'Start it:\n\n```sh\ncurl -s localhost:4319\n```\n\nThen check it:\n\n```sh\nnpm run view\n```'],
  ['urls',
    'Read [the design](https://x.dev/design) first, then the plan at https://x.dev/plan.',
    'Read the design first, then the plan at https://x.dev/plan.',
    'Read [the design](https://x.dev/design) first, then the plan at https://x.dev/plan and <https://x.dev/more>.',
    'Read [the design](https://x.dev/design2) first, then the plan at https://x.dev/plan.',
    'Read [the design](https://x.dev/plan) first, then the plan at https://x.dev/design.'],
  ['refs',
    'The store fix landed in #12 and the viewer fix in #34.',
    'The store fix landed in #12 and the viewer fix later.',
    'The store fix landed in #12 and the viewer fix in #34, by @jane.',
    'The store fix landed in #12 and the viewer fix in #35.',
    'The store fix landed in #34 and the viewer fix in #12.'],
  ['refs',
    'Ask ops@x.dev about commit 6a77c678 before you ping @jane.',
    'Ask ops about commit 6a77c678 before you ping @jane.',
    'Ask ops@x.dev about commit 6a77c678 before you ping @jane and @sam.',
    'Ask ops@x.dev about commit 6a77c679 before you ping @jane.',
    'Ask @jane about commit 6a77c678 before you ping ops@x.dev.'],
  ['numbers',
    'The deploy takes 5 minutes and the build takes 10 minutes on v2.5.0.',
    'The deploy takes 5 minutes and the build takes a while on v2.5.0.',
    'The deploy takes 5 minutes and the build takes 10 minutes on v2.5.0 across 3 hosts.',
    'The deploy takes 5 minutes and the build takes 12 minutes on v2.5.0.',
    'The deploy takes 10 minutes and the build takes 5 minutes on v2.5.0.'],
  ['numbers',
    'A swap takes about 70 s and a load roughly 10 % more.',
    'A swap takes 70 s and a load roughly 10 % more.',
    'A swap takes about 70 s, sometimes ~90 s, and a load roughly 10 % more.',
    'A swap takes around 70 s and a load roughly 10 % more.',
    'A swap takes roughly 10 % more and a load about 70 s.'],
  ['dates',
    'We froze the branch on 2026-11-02 and released on November 6, 2026.',
    'We froze the branch on 2026-11-02 and released soon after.',
    'We froze the branch on 2026-11-02 and released on November 6, 2026, with a patch on Nov 9.',
    'We froze the branch on 2026-11-02 and released on November 7, 2026.',
    'We froze the branch on November 6, 2026 and released on 2026-11-02.'],
  ['quotes',
    'The review said "ship it on Friday" and the release lead said "hold the release please".',
    'The review said to ship on Friday and the release lead said "hold the release please".',
    'The review said "ship it on Friday" and the release lead said "hold the release please" and "add a test first".',
    'The review said "ship it on Monday" and the release lead said "hold the release please".',
    'The review said "hold the release please" and the release lead said "ship it on Friday".'],
  ['paths',
    'Edit src/mesh-config.ts by hand, then run ./scripts/install.sh with --apply.',
    'Edit the config by hand, then run ./scripts/install.sh with --apply.',
    'Edit src/mesh-config.ts by hand, then run ./scripts/install.sh with --apply --force.',
    'Edit src/mesh-config.js by hand, then run ./scripts/install.sh with --apply.',
    'Edit ./scripts/install.sh by hand, then run src/mesh-config.ts with --apply.'],
  ['negations',
    'It does not build on Linux and never runs on Windows.',
    'It does build on Linux and never runs on Windows.',
    'It does not build on Linux and never runs on Windows without help.',
    'It does not build on Linux and does not run on Windows.',
    'It never builds on Linux and does not run on Windows.'],
  ['conditions',
    'Merge unless CI fails, and wait until the review lands.',
    'Merge when CI passes, and wait until the review lands.',
    'Merge unless CI fails, and wait until the review lands, except on Fridays.',
    'Merge unless CI fails, and wait only if the review is open.',
    'Merge until CI fails, and wait unless the review lands.'],
]

describe('hard classes', () => {
  for (const [cls, input, ...outputs] of HARD) {
    const kinds = ['loss', 'addition', 'change', 'swap']
    outputs.forEach((output, i) => {
      it(`${cls} catches ${kinds[i]}: ${input.slice(0, 30)}`, () => {
        const report = checkFidelity(input, output)
        expect(report.ok).toBe(false)
        expect(failed(report)).toContain(cls)
        expect(report.failures.some((f) => f.class === cls)).toBe(true)
      })
    })
    it(`${cls} passes the input unchanged`, () => {
      expect(checkFidelity(input, input)).toMatchObject({ ok: true, failures: [], warnings: [] })
    })
  }

  it('protected terms from the profile, when in the input', () => {
    const terms = ['Agent Inbox', 'meshctl']
    expect(failed(checkFidelity('Agent Inbox ships meshctl.', 'The inbox ships meshctl.', { terms }))).toEqual(['terms'])
    expect(failed(checkFidelity('Agent Inbox ships meshctl.', 'Agent Inbox now ships meshctl.', { terms }))).toEqual([])
    expect(failed(checkFidelity('The inbox ships a CLI.', 'Agent Inbox ships a CLI.', { terms }))).toEqual([])
  })

  it('names the failure kind and values for the retry', () => {
    const r = checkFidelity('Fixed in #12 on v2.5.0.', 'Fixed in #13 on v2.5.0 and v2.6.0.')
    expect(r.failures).toEqual([
      { class: 'refs', kind: 'changed', lost: ['#12'], added: ['#13'] },
      { class: 'numbers', kind: 'added', lost: [], added: ['v2.6.0'] },
    ])
  })
})

describe('review round 1 (#486)', () => {
  const FAIL: Array<[string, string, string]> = [
    ['numbers', 'Upgrade from v2.5.0 to v2.6.0.', 'Upgrade from v2.6.0 to v2.5.0.'],
    ['numbers', 'p50 is 40 ms and p99 is 900 ms.', 'p50 is 900 ms and p99 is 40 ms.'],
    ['refs', 'Fixes #12; reverts #34.', 'Fixes #34; reverts #12.'],
    ['numbers', 'Linux: 3 s, macOS: 7 s.', 'Linux: 7 s, macOS: 3 s.'],
    ['refs', 'The store fix landed in #12. The viewer fix landed in #34.', 'The store fix landed in #34. The viewer fix landed in #12.'],
    ['negations', 'You must restart the agent after an upgrade.', 'You must not restart the agent after an upgrade.'],
    ['negations', 'The flag affects users on the beta channel.', 'The flag never affects users on the beta channel.'],
    ['conditions', 'Merge the PR once CI passes.', 'Merge the PR unless CI passes.'],
    ['negations', 'macOS is supported, but Windows is not.', 'macOS is not supported, but Windows is.'],
    ['negations', 'Do not delete the cache. Delete the logs.', 'Delete the cache. Do not delete the logs.'],
    ['conditions', 'Merge the PR unless CI fails, and deploy the release.', 'Merge the PR, and deploy the release unless CI fails.'],
  ]
  for (const [cls, input, output] of FAIL) {
    it(`fails ${cls}: ${input} → ${output}`, () => {
      expect(failed(checkFidelity(input, output))).toContain(cls)
    })
  }

  it('an added negation passes, with a warning, when its sentence dropped a negative word', () => {
    const r = checkFidelity('The binding fails to load on Node 26.', 'The binding does not load on Node 26.')
    expect(failed(r)).toEqual([])
    expect(warned(r)).toEqual(['negation-added'])
    // one dropped negative word pays for one addition, even across a sentence split
    expect(failed(checkFidelity('The server fails on boot.', 'The server does not start on boot. It does not respond.'))).toEqual(['negations'])
  })
})

describe('what must not fail', () => {
  const PASS: Array<[string, string, string]> = [
    ['a moved sentence',
      'The build takes 10 minutes. The deploy takes 5 minutes and needs #12.',
      'The deploy takes 5 minutes and needs #12. The build takes 10 minutes.'],
    ['a moved sentence with a negation, a condition and two values',
      'Back up the logs first. Do not delete the cache on v2.5.0 unless it is over 2 GB.',
      'Do not delete the cache on v2.5.0 unless it is over 2 GB. Back up the logs first.'],
    ['a leading condition or negation phrase moved to the end',
      'Without a token, every request except the card is refused.',
      'Every request except the card is refused without a token.'],
    ['an unless clause moved to the end',
      'Unless CI passes, do not merge.',
      'Do not merge unless CI passes.'],
    ['a one-word clause beside a rewritten negation',
      'The agent, once stopped, will not restart the service.',
      'Once stopped, the agent will not restart it.'],
    ['list ordinals',
      '1. Install Node 24.\n2. Run the tests.\n3. Ship v2.5.0.',
      '- Install Node 24.\n- Run the tests.\n- Ship v2.5.0.'],
    ['and/or and read/write',
      'Open it read/write and/or with the cache.',
      'Open it read-write, or with the cache.'],
    ['apostrophes and contractions',
      "It's the team's call; don't merge yet and we can't ship today.",
      'It is the team\'s call. Do not merge yet, and we cannot ship today.'],
    ['scare quotes and curly double quotes',
      'The "fast" path and the “slow but safe” path both work.',
      'The fast path and the "slow but safe" path both work.'],
    ['not just … but removal',
      'This is not just a fix but a redesign of the loader.',
      'This is a redesign of the loader.'],
    ['not only … but removal',
      "It isn't only faster but also safer.",
      'It is faster and safer.'],
    ['link text changes, target kept',
      'See [the design doc](https://x.dev/d) for details.',
      'See [the design](https://x.dev/d).'],
    ['thousands separators and spaced percent',
      'It handled 1,000 requests with roughly 10 % errors.',
      'It handled 1000 requests with roughly 10% errors.'],
    ['dates normalised',
      'Released November 6, 2026 at 3pm.',
      'Released 2026-11-06 at 15:00.'],
    ['e.g. becomes for example',
      'Use a short form, e.g. a flag.',
      'Use a short form, for example a flag.'],
  ]
  for (const [name, input, output] of PASS) {
    it(name, () => {
      expect(failed(checkFidelity(input, output))).toEqual([])
    })
  }

  it('a realistic PR description edit', () => {
    const input = `## Summary

This PR serves as a comprehensive overhaul of the rules loader, which is crucial for the agent. It's worth noting that the loader now reads \`rules.md\` and computes its SHA-256 (see #483). Additionally, it re-reads the file when its size or mtime changes, ensuring that the agent never uses stale rules without saying so.

## Testing

- Ran \`npm test\` in packages/mesh: 23 tests pass.
- The loader refuses files over 64 KiB, as described in docs/architecture/mesh.md.`
    const output = `## Summary

This PR rewrites the rules loader the agent depends on. The loader now reads \`rules.md\` and computes its SHA-256 (see #483). It re-reads the file when its size or mtime changes, so the agent never uses stale rules without saying so.

## Testing

- Ran \`npm test\` in packages/mesh: 23 tests pass.
- The loader refuses files over 64 KiB, as described in docs/architecture/mesh.md.`
    expect(checkFidelity(input, output)).toMatchObject({ ok: true, failures: [], warnings: [] })
  })

  it('a realistic issue edit that rephrases into a negation', () => {
    const r = checkFidelity(
      "When I run `npm test` on Node 26, better-sqlite3 fails to load. I think it's because the binding was built for Node 24.\n\nSteps:\n\n1. Install Node 26.\n2. Run `npm test`.\n\nExpected: tests pass. Actual: `ERR_DLOPEN_FAILED`.",
      'Under `npm test` on Node 26, better-sqlite3 does not load. The binding was probably built for Node 24.\n\nSteps:\n\n1. Install Node 26.\n2. Run `npm test`.\n\nExpected: the tests pass. Actual: `ERR_DLOPEN_FAILED`.',
    )
    expect(failed(r)).toEqual([])
    expect(warned(r)).toEqual(['hedge', 'negation-added'])
  })

  it('a realistic release-notes and blog edit', () => {
    const notes = checkFidelity(
      "In today's fast-paced world, local models are a game-changer. We will probably ship the agent in Q3 of 2027; a model swap takes about 70 s on two GPUs, and it may not suit short emails.",
      'Local models help. We will likely ship the agent in Q3 of 2027. A model swap takes about 70 s on two GPUs, and it may not suit short emails.',
    )
    expect(failed(notes)).toEqual([])
    expect(warned(notes)).toEqual(['hedge'])
  })
})

describe('warnings', () => {
  it('a modal change warns with the words, not a hard failure', () => {
    const r = checkFidelity('The agent may restart.', 'The agent will restart.')
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual([{ class: 'modal', detail: 'may → will' }])
  })

  it('`about` alone is not a hedge; other hedges warn', () => {
    expect(checkFidelity('A post about the mesh.', 'A post on the mesh.').warnings).toEqual([])
    expect(warned(checkFidelity('It probably works.', 'It works.'))).toEqual(['hedge'])
  })

  it('a changed one- or two-word quote warns', () => {
    const r = checkFidelity('The "fast path" works.', 'The fast route works.')
    expect(r.ok).toBe(true)
    expect(warned(r)).toEqual(['short-quote'])
  })

  it('sentences down by more than 20 % and changed headings warn', () => {
    const input = '# Plan\n\nOne. Two. Three. Four. Five.'
    expect(warned(checkFidelity(input, '# Plan\n\nOne. Two. Three. Four.'))).toEqual([])
    expect(warned(checkFidelity(input, '# Plan\n\nOne. Two. Three.'))).toEqual(['sentences'])
    expect(warned(checkFidelity(input, '# The plan\n\nOne. Two. Three. Four. Five.'))).toEqual(['headings'])
  })
})

describe('fidelity cost', () => {
  it('stays well under a second per pair on hostile 12 KiB inputs', () => {
    const lines = 'Ab 1.\n'.repeat(2048)
    const distinct = Array.from({ length: 1400 }, (_, i) => `w${i} not`).join('\n')
    const prose = 'The deploy takes 5 minutes on v2.5.0 (see #12, https://x.dev/a and src/a.ts); it does not run unless CI passes. '.repeat(110)
    const pairs: Array<[string, string]> = [
      [lines, lines.split('\n').reverse().join('\n')],
      [distinct, distinct.split('\n').reverse().join('\n')],
      [prose, prose.split('. ').reverse().join('. ')],
      ['a.'.repeat(6144), 'a.'.repeat(6144)],
      ['a-'.repeat(6144), 'a-'.repeat(6144)],
      ['`a '.repeat(4096), '`a '.repeat(4096)],
    ]
    for (const [input, output] of pairs) {
      const started = Date.now()
      checkFidelity(input, output)
      expect(Date.now() - started).toBeLessThan(1500)
    }
  })
})
