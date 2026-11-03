// Issue #432: a driven session's own git worktree (design §1, §2, §5), against
// real git in scratch repositories only. createWorktree refuses before it
// creates anything; undoWorktree removes only what this launch made, the
// worktree before its branch, and spares a branch that moved.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree, gitEnv, inspectWorktree, removeLaunchWorktree, undoWorktree, unlockWorktree, worktreePlanError, worktreeSummarizer } from '../src/worktree.js'
import type { WorktreeSummary } from '../src/worktree.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const LAUNCH = '1a2b3c4d-3333-4444-8555-666666666666'
const GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
// macOS's default APFS volume: the temp folder is found under its uppercased path too
const CASE_INSENSITIVE = tmpdir().toUpperCase() !== tmpdir() && existsSync(tmpdir().toUpperCase())

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
    ['a root whose <repo> folder is the checkout itself', (r: ReturnType<typeof rig>) => ({
      plan: { path: join(r.dir, 'app', 'fix-tests-1a2b3c4d') },
    }), /would be inside the repository/],
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
    expect(existsSync(join(r.checkout, 'fix-tests-1a2b3c4d'))).toBe(false)
  })

  // review of #444: Node's realpathSync keeps the case it is given, so a root in another case passed
  // "not inside the checkout" and "its own real path", and git made the worktree inside the checkout
  it.skipIf(!CASE_INSENSITIVE).each([
    ['a missing root', (_r: ReturnType<typeof rig>) => undefined],
    ['an existing root', (r: ReturnType<typeof rig>) => { mkdirSync(join(r.checkout, 'trees'), { mode: 0o700 }) }],
  ] as Array<[string, (r: ReturnType<typeof rig>) => void]>)('refuses %s inside the checkout written in another letter case', (_, arrange) => {
    const r = rig()
    arrange(r)
    const before = existsSync(join(r.checkout, 'trees'))
    const made = r.create({ path: join(r.dir, 'APP', 'trees', 'app', 'fix-tests-1a2b3c4d') })
    expect(made).toMatchObject({ ok: false, error: expect.stringMatching(/on-disk letter case/) })
    expect(existsSync(join(r.checkout, 'trees'))).toBe(before)
    expect(existsSync(join(r.checkout, 'trees', 'app'))).toBe(false)
    expect(r.branches()).toEqual(['main'])
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

describe('Remove worktree (#432 §5)', () => {
  // a launch's worktree as the driver made it (locked), with one commit of the session's on its branch
  function made() {
    const r = rig()
    writeFileSync(join(r.checkout, '.gitignore'), 'node_modules/\n')
    r.git(r.checkout, 'add', '.gitignore')
    r.git(r.checkout, 'commit', '-q', '-m', 'ignore')
    const created = r.create()
    if (!created.ok) throw new Error(created.error)
    writeFileSync(join(r.plan.path, 'work.txt'), 'work\n')
    r.git(r.plan.path, 'add', 'work.txt')
    r.git(r.plan.path, 'commit', '-q', '-m', 'work')
    const target = { git: GIT, env: r.env, checkout: r.checkout, path: r.plan.path, branch: r.plan.branch, baseRef: 'refs/heads/main', baseSha: created.worktree.baseSha }
    return { ...r, target }
  }

  it('inspects and removes a clean worktree, even locked and with ignored files, and keeps its branch', () => {
    const r = made()
    mkdirSync(join(r.plan.path, 'node_modules'))
    writeFileSync(join(r.plan.path, 'node_modules', 'x.js'), 'x')
    expect(inspectWorktree(r.target)).toEqual({
      ok: true, state: { missing: false, dirty: 0, examples: [], noDiscard: null, ahead: 1, upstream: false, status: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
    expect(removeLaunchWorktree(r.target)).toEqual({ ok: true })
    expect(existsSync(r.plan.path)).toBe(false)
    expect(r.branches()).toEqual([r.plan.branch, 'main'].sort())
    expect(r.list()).not.toContain(r.plan.path)
    // already gone: nothing to do, and nothing else is touched
    expect(removeLaunchWorktree(r.target)).toEqual({ ok: true })
    expect(inspectWorktree(r.target)).toMatchObject({ ok: true, state: { missing: true, dirty: 0 } })
  })

  it.each([
    ['an untracked file', (dir: string) => writeFileSync(join(dir, 'new.txt'), 'new\n')],
    ['a modified file', (dir: string) => writeFileSync(join(dir, 'README.md'), 'changed\n')],
  ])('refuses to remove a worktree with %s unless the human discards exactly what they were shown', (_, change) => {
    const r = made()
    change(r.plan.path)
    const seen = inspectWorktree(r.target)
    if (!seen.ok) throw new Error(seen.error)
    expect(seen.state.dirty).toBe(1)
    expect(removeLaunchWorktree(r.target)).toMatchObject({ ok: false })
    expect(existsSync(r.plan.path)).toBe(true)
    // a change after the human looked: the hash no longer matches, and nothing is forced
    writeFileSync(join(r.plan.path, 'later.txt'), 'later\n')
    expect(removeLaunchWorktree({ ...r.target, discard: seen.state.status })).toEqual({ ok: false, error: expect.stringMatching(/changed since you looked/) })
    expect(existsSync(join(r.plan.path, 'later.txt'))).toBe(true)
    const again = inspectWorktree(r.target)
    if (!again.ok) throw new Error(again.error)
    expect(removeLaunchWorktree({ ...r.target, discard: again.state.status })).toEqual({ ok: true })
    expect(existsSync(r.plan.path)).toBe(false)
    expect(r.branches()).toContain(r.plan.branch)
  })

  // review of #446: the fingerprint a discard is bound to covers contents, not just names
  const state = (r: ReturnType<typeof made>) => {
    const seen = inspectWorktree(r.target)
    if (!seen.ok) throw new Error(seen.error)
    return seen.state
  }

  it('a further edit to a file already changed moves the fingerprint, so the older discard is refused', () => {
    const r = made()
    writeFileSync(join(r.plan.path, 'README.md'), 'changed once\n')
    const seen = state(r)
    expect(seen).toMatchObject({ dirty: 1, examples: ['README.md'], noDiscard: null })
    writeFileSync(join(r.plan.path, 'README.md'), 'changed twice\n')
    const now = state(r)
    expect(now.dirty).toBe(1)
    expect(now.status).not.toBe(seen.status)
    expect(removeLaunchWorktree({ ...r.target, discard: seen.status })).toEqual({ ok: false, error: expect.stringMatching(/changed since you looked/) })
    expect(readFileSync(join(r.plan.path, 'README.md'), 'utf8')).toBe('changed twice\n')
    // an untracked file's own content counts too, not only its name
    writeFileSync(join(r.plan.path, 'new.txt'), 'a\n')
    const before = state(r).status
    writeFileSync(join(r.plan.path, 'new.txt'), 'b\n')
    expect(state(r).status).not.toBe(before)
  })

  it('counts every file, and a new file under a folder already untracked moves the count and the fingerprint', () => {
    const r = made()
    mkdirSync(join(r.plan.path, 'out', 'deep'), { recursive: true })
    for (const name of ['a.txt', 'b.txt', 'deep/c.txt']) writeFileSync(join(r.plan.path, 'out', name), name)
    const seen = state(r)
    expect(seen).toMatchObject({ dirty: 3, examples: ['out/a.txt', 'out/b.txt', 'out/deep/c.txt'] })
    writeFileSync(join(r.plan.path, 'out', 'deep', 'd.txt'), 'd')
    const now = state(r)
    expect(now.dirty).toBe(4)
    expect(now.status).not.toBe(seen.status)
    expect(removeLaunchWorktree({ ...r.target, discard: seen.status })).toMatchObject({ ok: false })
    expect(existsSync(join(r.plan.path, 'out', 'deep', 'd.txt'))).toBe(true)
    expect(removeLaunchWorktree({ ...r.target, discard: now.status })).toEqual({ ok: true })
  })

  it('refuses Discard for a nested repository, naming it, and keeps its commits', () => {
    const r = made()
    const nested = join(r.plan.path, 'vendor', 'lib')
    mkdirSync(nested, { recursive: true })
    r.git(nested, '-c', 'init.defaultBranch=main', 'init', '-q')
    writeFileSync(join(nested, 'x.txt'), 'x')
    r.git(nested, 'add', 'x.txt')
    r.git(nested, '-c', 'user.name=shariqh', '-c', 'user.email=shariqh@users.noreply.github.com', 'commit', '-q', '-m', 'nested')
    const seen = state(r)
    expect(seen).toMatchObject({ dirty: 1, status: '', noDiscard: 'It contains a nested git repository at vendor/lib/; move it out first.' })
    expect(removeLaunchWorktree({ ...r.target, discard: 'a'.repeat(64) })).toEqual({ ok: false, error: expect.stringMatching(/nested git repository at vendor\/lib\//) })
    expect(removeLaunchWorktree(r.target)).toMatchObject({ ok: false })
    expect(r.git(nested, 'log', '--oneline')).toContain('nested')
  })

  it('refuses Discard for a checked-out submodule, naming it, and keeps its unpushed commit (review of #446)', () => {
    const r = made()
    const source = join(r.dir, 'lib-src')
    mkdirSync(source)
    r.git(source, '-c', 'init.defaultBranch=main', 'init', '-q')
    writeFileSync(join(source, 'lib.txt'), 'lib')
    r.git(source, 'add', 'lib.txt')
    r.git(source, '-c', 'user.name=shariqh', '-c', 'user.email=shariqh@users.noreply.github.com', 'commit', '-q', '-m', 'lib')
    r.git(r.plan.path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'sub')
    const sub = join(r.plan.path, 'sub')
    writeFileSync(join(sub, 'local.txt'), 'unpushed')
    r.git(sub, 'add', 'local.txt')
    r.git(sub, '-c', 'user.name=shariqh', '-c', 'user.email=shariqh@users.noreply.github.com', 'commit', '-q', '-m', 'unpushed work')
    const seen = state(r)
    expect(seen).toMatchObject({ status: '', noDiscard: expect.stringMatching(/^It contains a checked-out submodule at sub\/; Remove won’t delete it\./) })
    expect(removeLaunchWorktree({ ...r.target, discard: 'a'.repeat(64) })).toEqual({ ok: false, error: expect.stringMatching(/checked-out submodule at sub\//) })
    expect(removeLaunchWorktree(r.target)).toMatchObject({ ok: false })
    expect(r.git(sub, 'log', '--oneline')).toContain('unpushed work')
    // committed in the worktree too: the gitlink is tracked, and still refused
    r.git(r.plan.path, 'commit', '-q', '-m', 'add sub')
    writeFileSync(join(sub, 'more.txt'), 'more')
    expect(state(r).noDiscard).toMatch(/checked-out submodule at sub\//)
  })

  it('refuses Discard for a worktree with too many changed files to fingerprint', () => {
    const r = made()
    mkdirSync(join(r.plan.path, 'many'))
    for (let i = 0; i <= 20_000; i++) writeFileSync(join(r.plan.path, 'many', `${i}`), '')
    const seen = state(r)
    expect(seen).toMatchObject({ dirty: 20_001, status: '', noDiscard: expect.stringMatching(/more than 20,000 changed files/) })
    expect(removeLaunchWorktree({ ...r.target, discard: 'a'.repeat(64) })).toEqual({ ok: false, error: expect.stringMatching(/more than 20,000 changed files/) })
    expect(existsSync(join(r.plan.path, 'many', '20000'))).toBe(true)
  }, 60_000)

  it('removes git’s entry for a worktree whose folder was deleted by hand', () => {
    const r = made()
    rmSync(r.plan.path, { recursive: true, force: true })
    expect(inspectWorktree(r.target)).toMatchObject({ ok: true, state: { missing: true, dirty: 0, ahead: 1 } })
    expect(removeLaunchWorktree(r.target)).toEqual({ ok: true })
    expect(r.list()).not.toContain(r.plan.path)
    expect(r.branches()).toContain(r.plan.branch)
  })

  it('leaves a worktree alone that is no longer on its branch, or that git does not list', () => {
    const r = made()
    r.git(r.plan.path, 'switch', '-q', '-c', 'elsewhere')
    expect(inspectWorktree(r.target)).toEqual({ ok: false, error: expect.stringMatching(/no longer on agent-inbox\/fix-tests-1a2b3c4d/) })
    expect(removeLaunchWorktree(r.target)).toMatchObject({ ok: false })
    expect(existsSync(r.plan.path)).toBe(true)
    const other = join(r.dir, 'other')
    mkdirSync(other)
    expect(inspectWorktree({ ...r.target, path: other })).toEqual({ ok: false, error: expect.stringMatching(/does not list/) })
    expect(removeLaunchWorktree({ ...r.target, path: other })).toMatchObject({ ok: false })
    expect(existsSync(other)).toBe(true)
  })
})

describe('the turn-end summary (#432 §6)', () => {
  // a git that records each call and, while HANG exists, hangs on `branch --show-current` (a summary-only command)
  function wrapped(r: ReturnType<typeof rig>) {
    const bin = join(r.dir, 'bin')
    mkdirSync(bin)
    const calls = join(r.dir, 'git-calls.log')
    writeFileSync(calls, '')
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$$ $*" >> '${calls}'\nif [ "$3" = branch ] && [ -e '${join(r.dir, 'HANG')}' ]; then exec sleep 600; fi\nexec '${GIT}' "$@"\n`)
    chmodSync(join(bin, 'git'), 0o755)
    const lines = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean)
    return { git: join(bin, 'git'), lines, reads: () => lines().filter((l) => l.includes('rev-parse --verify -q HEAD^{commit}')).length, hang: () => writeFileSync(join(r.dir, 'HANG'), '') }
  }
  function setup() {
    const r = rig()
    const made = r.create()
    if (!made.ok) throw new Error(made.error)
    const written: WorktreeSummary[] = []
    const summarizer = (git = GIT, finalMs?: number) => worktreeSummarizer({
      git, env: r.env, path: r.plan.path, baseRef: 'refs/heads/main', baseSha: made.worktree.baseSha, write: (s) => { written.push(s) },
      ...(finalMs ? { finalMs } : {}),
    })
    return { ...r, made, written, summarizer }
  }

  it('reads the branch, commits ahead and behind and files changed against one base, and every uncommitted file', async () => {
    const r = setup()
    await r.summarizer().final()
    expect(r.written.at(-1)).toEqual({ v: 1, at: expect.any(String), head: r.made.worktree.baseSha, branch: r.plan.branch, ahead: 0, behind: 0, files: 0, dirty: 0 })
    // a commit in the worktree, an edit left uncommitted, and the checkout's branch moving on
    writeFileSync(join(r.plan.path, 'a.txt'), 'a\n')
    r.git(r.plan.path, 'add', 'a.txt')
    r.git(r.plan.path, 'commit', '-q', '-m', 'a')
    writeFileSync(join(r.plan.path, 'README.md'), 'edited\n')
    r.commit('later.md')
    await r.summarizer().final()
    expect(r.written.at(-1)).toMatchObject({ branch: r.plan.branch, ahead: 1, behind: 1, files: 1, dirty: 1, head: r.git(r.plan.path, 'rev-parse', 'HEAD') })
    // every untracked file counts, whatever status.showUntrackedFiles says: Remove worktree's dialog counts the same
    r.git(r.plan.path, 'config', 'status.showUntrackedFiles', 'no')
    mkdirSync(join(r.plan.path, 'out'))
    for (const name of ['x', 'y', 'z']) writeFileSync(join(r.plan.path, 'out', name), name)
    await r.summarizer().final()
    expect(r.written.at(-1)).toMatchObject({ dirty: 4 })
    // the agent switched branch: the summary names the branch it is on now
    r.git(r.plan.path, 'switch', '-q', '-c', 'side')
    await r.summarizer().final()
    expect(r.written.at(-1)).toMatchObject({ branch: 'side', ahead: 1 })
    // a read that fails writes nothing, so the last summary stays
    const count = r.written.length
    rmSync(r.plan.path, { recursive: true, force: true })
    await r.summarizer().final()
    expect(r.written).toHaveLength(count)
  })

  it('a request during a read runs exactly once after it, and its result is written', async () => {
    const r = setup()
    const git = wrapped(r)
    const summarizer = r.summarizer(git.git)
    summarizer.request()
    summarizer.request()
    summarizer.request()
    for (let i = 0; i < 200 && r.written.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(git.reads()).toBe(2)
    expect(r.written).toHaveLength(2)
    expect(r.written[1]).toMatchObject({ branch: r.plan.branch, dirty: 0 })
  })

  it('final() drops a queued repeat and gives up within its budget, killing git that hangs, writing nothing', async () => {
    const r = setup()
    const git = wrapped(r)
    git.hang()
    const summarizer = r.summarizer(git.git, 400)
    summarizer.request()
    summarizer.request()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const started = Date.now()
    await summarizer.final()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(r.written).toEqual([])
    // the hanging git was killed, and nothing reads after final()
    const hung = git.lines().filter((l) => l.includes(' branch --show-current')).map((l) => Number(l.split(' ')[0]))
    expect(hung.length).toBeGreaterThan(0)
    for (const pid of hung) expect(() => process.kill(pid, 0)).toThrow()
    const reads = git.reads()
    summarizer.request()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(git.reads()).toBe(reads)
  })
})
