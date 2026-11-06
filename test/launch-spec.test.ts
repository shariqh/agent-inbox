// Issue #412 step 3: the fd-3 launch spec (design §8) and the approval MAC
// (§4.3, §14.3). The spec is versioned and validated strictly: exact fields,
// bounded budgets, no path but an absolute folder, no argv or executable. The
// MAC is checked against an independent implementation of the wire format
// (test/launch-fixtures.ts), so main and driver cannot drift silently.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { LAUNCH_BUDGETS, parseLaunchSpec } from '../src/launch-spec.js'
import { verifyApproval } from '../src/launch-sign.js'
import { LAUNCH_KEY, launchKey, sign } from './launch-fixtures.js'

const ID = '22222222-3333-4444-8555-666666666666'
const KEY = LAUNCH_KEY.toString('base64')

const spec = (over: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, kind: 'new', launchId: ID, host: 'copilot', cwd: '/work/app', mode: 'plan', budgets: { activeMs: 3_600_000, toolCalls: 200 },
  prompt: 'Fix it.', env: { PATH: '/usr/bin:/bin', HOME: '/home/someone' }, launchKey: KEY, ...over,
})

describe('the launch spec (§8)', () => {
  it('parses a new spec and a resume spec, with the key as bytes', () => {
    const parsed = parseLaunchSpec(spec({ model: 'claude-haiku-4.5', reasoningEffort: 'none' }), ID)
    expect(parsed).toEqual({
      ok: true,
      spec: {
        v: 1, kind: 'new', launchId: ID, host: 'copilot', cwd: '/work/app', mode: 'plan', model: 'claude-haiku-4.5', reasoningEffort: 'none',
        budgets: { activeMs: 3_600_000, toolCalls: 200 }, prompt: 'Fix it.', env: { PATH: '/usr/bin:/bin', HOME: '/home/someone' }, launchKey: LAUNCH_KEY,
      },
    })
    // Edits in the worktree (#412 step 3, PR 4) is a launch mode like the others
    expect(parseLaunchSpec(spec({ mode: 'edits' }), ID)).toMatchObject({ ok: true, spec: { mode: 'edits' } })
    // #432: a new worktree of cwd, at the path and on the branch main planned for this launch id
    const worktree = { path: '/home/shariqh/.agent-inbox/worktrees/app/fix-it-22222222', branch: 'agent-inbox/fix-it-22222222' }
    expect(parseLaunchSpec(spec({ worktree }), ID)).toMatchObject({ ok: true, spec: { cwd: '/work/app', worktree } })
    // #432 §5: the human's cap, on a new spec and a resume spec alike
    expect(parseLaunchSpec(spec({ maxDrivers: 4 }), ID)).toMatchObject({ ok: true, spec: { maxDrivers: 4 } })
    expect(parseLaunchSpec(JSON.stringify({ v: 1, kind: 'resume', launchId: ID, env: {}, launchKey: KEY, maxDrivers: 8 }), ID)).toMatchObject({ ok: true, spec: { maxDrivers: 8 } })
    expect(parseLaunchSpec(JSON.stringify({ v: 1, kind: 'resume', launchId: ID, env: {}, launchKey: KEY }), ID))
      .toEqual({ ok: true, spec: { v: 1, kind: 'resume', launchId: ID, env: {}, launchKey: LAUNCH_KEY } })
    // #479: either budget may be null, no limit
    for (const budgets of [{ activeMs: null, toolCalls: null }, { activeMs: 60_000, toolCalls: null }, { activeMs: null, toolCalls: 1 }]) {
      expect(parseLaunchSpec(spec({ budgets }), ID)).toMatchObject({ ok: true, spec: { budgets } })
    }
    // #451: a resume with more budget, bound to the row revision main's confirmation read
    const raise = { revision: 7, activeMs: 0, toolCalls: LAUNCH_BUDGETS.toolCalls.max }
    expect(parseLaunchSpec(JSON.stringify({ v: 1, kind: 'resume', launchId: ID, env: {}, launchKey: KEY, raise }), ID)).toMatchObject({ ok: true, spec: { raise } })
  })

  it.each([
    ['another launch', spec(), /launchId must be/, '33333333-3333-4333-8333-333333333333'],
    ['a newer version', spec({ v: 2 }), /version 2 is not 1/],
    ['an executable', spec({ command: '/bin/sh' }), /unknown field command/],
    ['argv', spec({ args: ['--yolo'] }), /unknown field args/],
    ['a relative folder', spec({ cwd: 'work/app' }), /absolute path/],
    ['an unknown mode', spec({ mode: 'autopilot' }), /mode must be/],
    ['a model that is not an id', spec({ model: 'x --yolo' }), /model id/],
    ['an unknown effort', spec({ reasoningEffort: 'turbo' }), /effort level/],
    ['a budget below its floor', spec({ budgets: { activeMs: LAUNCH_BUDGETS.activeMs.min - 1, toolCalls: 1 } }), /out of bounds/],
    ['a budget above its ceiling', spec({ budgets: { activeMs: 60_000, toolCalls: LAUNCH_BUDGETS.toolCalls.max + 1 } }), /out of bounds/],
    ['a budget left out rather than null (#479)', spec({ budgets: { activeMs: 60_000 } }), /budgets must hold/],
    ['a budget of 0 rather than null (#479)', spec({ budgets: { activeMs: 60_000, toolCalls: 0 } }), /out of bounds/],
    ['a USD budget Copilot does not have', spec({ budgets: { activeMs: 60_000, toolCalls: 1, usd: 5 } }), /budgets must hold/],
    ['an empty prompt', spec({ prompt: '   ' }), /prompt must hold/],
    ['an env value that is not text', spec({ env: { PATH: 1 } }), /env must map/],
    ['an env name that is not a name', spec({ env: { 'A=B': 'c' } }), /env must map/],
    ['a short key', spec({ launchKey: Buffer.alloc(16).toString('base64') }), /32 bytes/],
    ['a worktree with a root of its own', spec({ worktree: { path: '/w/app/fix-it-22222222', branch: 'agent-inbox/fix-it-22222222', root: '/w' } }), /unknown worktree field root/],
    ['a worktree for another launch', spec({ worktree: { path: '/w/app/fix-it-33333333', branch: 'agent-inbox/fix-it-33333333' } }), /first 8 digits/],
    ['a worktree branch that is not agent-inbox’s', spec({ worktree: { path: '/w/app/main', branch: 'main' } }), /worktree branch must be/],
    ['a worktree path a tool pattern would read', spec({ worktree: { path: '/w/a[1]/fix-it-22222222', branch: 'agent-inbox/fix-it-22222222' } }), /none of/],
    ['a relative worktree path', spec({ worktree: { path: 'w/app/fix-it-22222222', branch: 'agent-inbox/fix-it-22222222' } }), /normalized absolute path/],
    ['a cap of none', spec({ maxDrivers: 0 }), /maxDrivers must be 1 to 8/],
    ['a cap above 8', spec({ maxDrivers: 9 }), /maxDrivers must be 1 to 8/],
    ['a cap that is not a whole number', spec({ maxDrivers: 2.5 }), /maxDrivers must be 1 to 8/],
    ...([
      ['nothing', { revision: 1, activeMs: 0, toolCalls: 0 }, /raise is out of bounds/],
      ['more than a launch may have', { revision: 1, activeMs: LAUNCH_BUDGETS.activeMs.max + 1, toolCalls: 0 }, /raise is out of bounds/],
      ['less', { revision: 1, activeMs: 60_000, toolCalls: -1 }, /raise is out of bounds/],
      ['no revision', { activeMs: 60_000, toolCalls: 1 }, /raise must hold/],
      ['totals of its own', { revision: 1, activeMs: 60_000, toolCalls: 1, total: 9 }, /raise must hold/],
    ] as const).map(([what, raise, error]) => [`a raise of ${what} (#451)`, JSON.stringify({ v: 1, kind: 'resume', launchId: ID, env: {}, launchKey: KEY, raise }), error]),
    ['a new spec with a raise', spec({ raise: { revision: 1, activeMs: 60_000, toolCalls: 1 } }), /unknown field raise/],
    ['a resume that names facts', JSON.stringify({ v: 1, kind: 'resume', launchId: ID, env: {}, launchKey: KEY, mode: 'ask' }), /unknown field mode/],
  ] as Array<[string, string, RegExp, string?]>)('refuses %s', (_, text, error, launchId = ID) => {
    const parsed = parseLaunchSpec(text, launchId)
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.error).toMatch(error)
  })

  it('reads fd 3 to its end and refuses more than 1 MiB', () => {
    // a shell pipe on fd 3, as main's is
    const run = (bytes: number) => spawnSync('/bin/sh', ['-c', `head -c ${bytes} /dev/zero | tr '\\0' x | "$0" --import tsx --input-type=module -e "$1" 3<&0`, process.execPath, `
      import { readSpec } from './src/launch-spec.ts'
      const text = readSpec(3)
      process.stdout.write(typeof text === 'string' ? String(text.length) : text.error)`], {
      cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8',
    }).stdout
    expect(run(300_000)).toBe('300000')
    expect(run(1024 * 1024 + 1)).toBe('the launch spec is larger than 1 MiB')
  })
})

describe('the approval MAC (§4.3, §14.3)', () => {
  const ask = { item: 'item-1', revision: 0, optionId: 'allow_once' }

  it('verifies exactly main’s signature over the ask, its filing revision and the option', () => {
    const key = launchKey(Buffer.alloc(32, 5), ID)
    expect(verifyApproval(key, ask, sign(key, 'item-1', 0, 'allow_once'))).toBe(true)
    expect(verifyApproval(key, ask, sign(key, 'item-1', 1, 'allow_once'))).toBe(false)
    expect(verifyApproval(key, ask, sign(key, 'item-2', 0, 'allow_once'))).toBe(false)
    expect(verifyApproval(key, ask, sign(key, 'item-1', 0, 'reject_once'))).toBe(false)
    expect(verifyApproval(launchKey(Buffer.alloc(32, 5), '33333333-3333-4333-8333-333333333333'), ask, sign(key, 'item-1', 0, 'allow_once'))).toBe(false)
  })

  it('length-prefixes every part, so shifting bytes between fields never verifies', () => {
    const key = LAUNCH_KEY
    expect(verifyApproval(key, { item: 'item-10', revision: 0, optionId: 'x' }, sign(key, 'item-1', 0, '0x'))).toBe(false)
    expect(verifyApproval(key, { item: 'a', revision: 10, optionId: 'b' }, sign(key, 'a1', 0, 'b'))).toBe(false)
  })

  it('refuses a malformed signature, a wrong-size key or a negative revision without throwing', () => {
    const good = sign(LAUNCH_KEY, 'item-1', 0, 'allow_once')
    expect(verifyApproval(LAUNCH_KEY, ask, null)).toBe(false)
    expect(verifyApproval(LAUNCH_KEY, ask, good.toUpperCase())).toBe(false)
    expect(verifyApproval(LAUNCH_KEY, ask, good.slice(2))).toBe(false)
    expect(verifyApproval(Buffer.alloc(16, 7), ask, good)).toBe(false)
    expect(verifyApproval(LAUNCH_KEY, { ...ask, revision: -1 }, good)).toBe(false)
  })
})
