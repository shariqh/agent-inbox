// Issue #432: a driven session's own git worktree (design §1, §2, §5), against
// real git in scratch repositories only. createWorktree refuses before it
// creates anything; undoWorktree removes only what this launch made, the
// worktree before its branch, and spares a branch that moved.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWorktree, gitEnv, undoWorktree, unlockWorktree, worktreePlanError } from '../src/worktree.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const LAUNCH = '1a2b3c4d-3333-4444-8555-666666666666'
const GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

afterEach(() => removeScratchDirs())

function rig() {
  const dir = realpathSync(scratchDir('worktree-'))
  const env = gitEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' })
  const git = (cwd: string, ...args: string[]) => execFileSync(GIT, ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim()
  const checkout = join(dir, 'app')
  mkdirSync(checkout)
  git(checkout, '-c', 'init.defaultBranch=main', 'init', '-q')
  git(checkout, 'config', 'user.name', 'shariqh')
  git(checkout, 'config', 'user.email', 'shariqh@users.noreply.github.com')
  const commit = (file: string) => {
    writeFileSync(join(checkout, file), `${file}\n`)
    git(checkout, 'add', file)
    git(checkout, 'commit', '-q', '-m', file)
  }
  commit('README.md')
  const root = join(dir, 'worktrees')
  const plan = { path: join(root, 'app', 'fix-tests-1a2b3c4d'), branch: 'agent-inbox/fix-tests-1a2b3c4d' }
  const create = (over: Partial<typeof plan> = {}, from = checkout) => createWorktree({ git: GIT, env, checkout: from, plan: { ...plan, ...over }, launchId: LAUNCH })
  const branches = () => git(checkout, 'branch', '--format=%(refname:short)').split('\n').sort()
  const list = () => git(checkout, 'worktree', 'list', '--porcelain')
  return { dir, env, git, checkout, commit, root, plan, create, branches, list }
}

describe('a launch’s worktree (#432)', () => {
  it('is made locked from the checkout’s HEAD on its own branch, leaving the checkout’s changes there', () => {
    const r = rig()
    writeFileSync(join(r.checkout, 'README.md'), 'edited\n')
    writeFileSync(join(r.checkout, 'scratch.txt'), 'untracked\n')
    const made = r.create()
    expect(made).toEqual({
      ok: true,
      worktree: {
        checkout: r.checkout, path: r.plan.path, branch: r.plan.branch, baseSha: r.git(r.checkout, 'rev-parse', 'HEAD'),
        baseRef: 'refs/heads/main', dirty: 2,
      },
    })
    expect(r.git(r.plan.path, 'branch', '--show-current')).toBe(r.plan.branch)
    expect(readFileSync(join(r.plan.path, 'README.md'), 'utf8')).toBe('README.md\n')
    expect(existsSync(join(r.plan.path, 'scratch.txt'))).toBe(false)
    expect(r.list()).toContain(`worktree ${r.plan.path}\nHEAD ${r.git(r.checkout, 'rev-parse', 'HEAD')}\nbranch refs/heads/${r.plan.branch}\nlocked agent-inbox launch 1a2b3c4d`)
    // the root and the repository folder it made are private
    for (const dir of [r.root, join(r.root, 'app')]) expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(unlockWorktree(GIT, r.env, r.checkout, r.plan.path)).toBeNull()
    expect(r.list()).not.toContain('locked')
  })

  it('records no base branch on a detached HEAD', () => {
    const r = rig()
    r.git(r.checkout, 'checkout', '-q', '--detach')
    expect(r.create()).toMatchObject({ ok: true, worktree: { baseRef: null, dirty: 0 } })
  })

  it.each([
    ['an unborn repository', (r: ReturnType<typeof rig>) => {
      const empty = join(r.dir, 'empty')
      mkdirSync(empty)
      r.git(empty, 'init', '-q')
      return { from: empty }
    }, /^This repository has no commits yet$/],
    ['a bare repository', (r: ReturnType<typeof rig>) => {
      const bare = join(r.dir, 'bare.git')
      execFileSync(GIT, ['clone', '-q', '--bare', r.checkout, bare], { env: r.env })
      return { from: bare }
    }, /is not the top folder of a git repository/],
    ['a subfolder', (r: ReturnType<typeof rig>) => {
      mkdirSync(join(r.checkout, 'sub'))
      return { from: join(r.checkout, 'sub') }
    }, /is not the top folder of a git repository/],
    ['a folder outside any repository', (r: ReturnType<typeof rig>) => {
      mkdirSync(join(r.dir, 'plain'))
      return { from: join(r.dir, 'plain') }
    }, /is not the top folder of a git repository/],
    ['an existing branch', (r: ReturnType<typeof rig>) => {
      r.git(r.checkout, 'branch', r.plan.branch)
      return {}
    }, /a branch named agent-inbox\/fix-tests-1a2b3c4d already exists/],
    ['an existing path, even an empty folder', (r: ReturnType<typeof rig>) => {
      mkdirSync(r.plan.path, { recursive: true, mode: 0o700 })
      return {}
    }, /fix-tests-1a2b3c4d already exists$/],
    ['a symlinked root', (r: ReturnType<typeof rig>) => {
      mkdirSync(join(r.dir, 'real'), { mode: 0o700 })
      symlinkSync(join(r.dir, 'real'), r.root)
      return {}
    }, /is a symlink or lies under one/],
    ['a symlinked repository folder', (r: ReturnType<typeof rig>) => {
      mkdirSync(join(r.dir, 'real'), { mode: 0o700 })
      mkdirSync(r.root, { mode: 0o700 })
      symlinkSync(join(r.dir, 'real'), join(r.root, 'app'))
      return {}
    }, /is a symlink or lies under one/],
    ['a missing root under a symlinked folder', (r: ReturnType<typeof rig>) => {
      mkdirSync(join(r.dir, 'real'), { mode: 0o700 })
      symlinkSync(join(r.dir, 'real'), join(r.dir, 'link'))
      return { plan: { path: join(r.dir, 'link', 'worktrees', 'app', 'fix-tests-1a2b3c4d') } }
    }, /lies under a symlink/],
    ['a root others can write', (r: ReturnType<typeof rig>) => {
      mkdirSync(r.root)
      chmodSync(r.root, 0o777)
      return {}
    }, /is not owned by you, or is writable by others/],
    ['a root inside the checkout', (r: ReturnType<typeof rig>) => ({
      plan: { path: join(r.checkout, 'wt', 'app', 'fix-tests-1a2b3c4d') },
    }), /is inside the repository/],
    ['a pattern character in the path', (r: ReturnType<typeof rig>) => ({
      plan: { path: join(r.dir, 'work (1)', 'app', 'fix-tests-1a2b3c4d') },
    }), /none of \( \) \*/],
  ] as Array<[string, (r: ReturnType<typeof rig>) => { from?: string; plan?: { path: string } }, RegExp]>)('refuses %s and creates nothing', (_, arrange, error) => {
    const r = rig()
    const { from, plan } = arrange(r)
    const before = r.branches()
    const made = r.create(plan, from)
    expect(made.ok).toBe(false)
    expect(made.ok ? '' : made.error).toMatch(error)
    expect(r.branches()).toEqual(before)
    expect(r.list().split('\n').filter((line) => line.startsWith('worktree '))).toEqual([`worktree ${r.checkout}`])
    expect(existsSync(join(r.checkout, 'wt'))).toBe(false)
    expect(existsSync(join(r.dir, 'real', 'worktrees'))).toBe(false)
  })

  it('an undo removes the worktree, its lock and its branch; a branch that moved survives', () => {
    const r = rig()
    const made = r.create()
    if (!made.ok) throw new Error(made.error)
    expect(undoWorktree(GIT, r.env, made.worktree)).toBe(true)
    expect(existsSync(r.plan.path)).toBe(false)
    expect(r.branches()).toEqual(['main'])
    expect(r.list()).not.toContain(r.plan.path)

    const again = r.create()
    if (!again.ok) throw new Error(again.error)
    writeFileSync(join(r.plan.path, 'work.txt'), 'work\n')
    r.git(r.plan.path, 'add', 'work.txt')
    r.git(r.plan.path, 'commit', '-q', '-m', 'work')
    expect(undoWorktree(GIT, r.env, again.worktree)).toBe(true)
    expect(r.branches()).toEqual([r.plan.branch, 'main'].sort())
  })

  it('checks the planned path and branch against the launch id', () => {
    const plan = { path: '/home/shariqh/.agent-inbox/worktrees/app/fix-tests-1a2b3c4d', branch: 'agent-inbox/fix-tests-1a2b3c4d' }
    expect(worktreePlanError(plan, LAUNCH)).toBeNull()
    expect(worktreePlanError(plan, '9a2b3c4d-3333-4444-8555-666666666666')).toMatch(/first 8 digits/)
    expect(worktreePlanError({ ...plan, branch: 'agent-inbox/fix-1a2b3c4d' }, LAUNCH)).toMatch(/first 8 digits/)
    expect(worktreePlanError({ ...plan, branch: 'main' }, LAUNCH)).toMatch(/agent-inbox\/<slug>/)
    expect(worktreePlanError({ ...plan, path: '/home/shariqh/x/../app/fix-tests-1a2b3c4d' }, LAUNCH)).toMatch(/normalized/)
    expect(worktreePlanError({ ...plan, path: '/home/shariqh/.x/fix-tests-1a2b3c4d' }, LAUNCH)).toMatch(/<root>\/<repo>/)
    expect(worktreePlanError({ ...plan, path: '/app/fix-tests-1a2b3c4d' }, LAUNCH)).toMatch(/<root>\/<repo>/)
    expect(worktreePlanError({ ...plan, base: 'main' }, LAUNCH)).toMatch(/unknown worktree field base/)
  })
})
