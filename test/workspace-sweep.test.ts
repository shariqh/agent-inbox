// scripts/workspace-sweep.sh (#248): a dry-run-by-default sweep of agent
// worktrees, branches, remote branches, build outputs and test temp entries.
// Every test builds its own scratch repository with a bare "origin", a fake
// `gh` on PATH that prints canned PR states, a scratch HOME and a scratch
// TMPDIR, so nothing outside the scratch directory is read or written.
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = resolve(import.meta.dirname, '..')
const SCRIPT = join(REPO, 'scripts', 'workspace-sweep.sh')
const TEST_TIMEOUT_MS = 120_000
// Setup commits are dated three days back so only what a test makes "now" is recent.
const OLD_EPOCH = Math.floor(Date.now() / 1000) - 3 * 24 * 3600

afterEach(removeScratchDirs)

interface Fixture {
  root: string
  main: string
  wt: string
  home: string
  tmp: string
  origin: string
  env: NodeJS.ProcessEnv
  prs: string
  tips: Record<string, string>
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr}`)
  return r.stdout.trim()
}

function touchStamp(epoch: number): string {
  const d = new Date(epoch * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`
}

function ageTree(dir: string, env: NodeJS.ProcessEnv): void {
  run('find', [dir, '-exec', 'touch', '-h', '-t', touchStamp(OLD_EPOCH), '{}', '+'], dir, env)
}

/**
 * The scenario every test shares:
 * - worktree `merged` (feat/merged, pushed, PR #1 merged): proposed for removal, with its branch
 *   and its remote branch;
 * - worktree `open` (feat/open, PR #2 open), `dirty` (PR #3 merged, an untracked file) and
 *   `recent` (PR #4 merged, created now): kept, as are their branches (checked out);
 * - the main checkout on feat/current (PR #5 merged): kept as the current branch;
 * - feat/base (PR #7 merged) is the base of open PR #6: kept;
 * - feat/unmerged (no PR, a commit found nowhere else): kept;
 * - feat/old-merged (PR #8 merged, no worktree): proposed for removal;
 * - origin/feat/moved (PR #9 merged): a commit to push to it later waits in the `other` clone;
 * - worktree `stale` (feat/stale, no PR): its only copy elsewhere was origin/feat/stale, which was
 *   deleted on origin after the main checkout last fetched, so only a stale ref vouches for it;
 * - `orphan` is a plain directory in the worktree folder: kept;
 * - out/ in the main checkout (ignored, old): proposed for removal; dist/ and node_modules/ are
 *   never listed.
 */
function fixture(): Fixture {
  const root = realpathSync(scratchDir('workspace-sweep-'))
  const origin = join(root, 'origin.git')
  const main = join(root, 'main')
  const wt = join(root, 'wt')
  const home = join(root, 'home')
  const tmp = join(root, 'tmp')
  const bin = join(root, 'bin')
  const prs = join(root, 'prs.tsv')
  for (const d of [wt, home, tmp, bin]) mkdirSync(d)
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$FAKE_GH_LOG"',
      '[ "${FAKE_GH_EXIT:-0}" = 0 ] || exit "$FAKE_GH_EXIT"',
      // --apply reloads PR states after the listing: this runs between listing and deletion.
      'if [ -n "${FAKE_GH_ON_SECOND:-}" ] && [ "$(grep -c . "$FAKE_GH_LOG")" = 2 ]; then sh -c "$FAKE_GH_ON_SECOND" >/dev/null 2>&1; fi',
      'cat "$FAKE_GH_PRS"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const date = `${OLD_EPOCH} +0000`
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: home,
    TMPDIR: tmp,
    LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Sweep Test',
    GIT_AUTHOR_EMAIL: 'sweep@example.invalid',
    GIT_COMMITTER_NAME: 'Sweep Test',
    GIT_COMMITTER_EMAIL: 'sweep@example.invalid',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    FAKE_GH_PRS: prs,
    FAKE_GH_LOG: join(root, 'gh.log'),
  }
  // No background auto-gc: it would repack the fixture while a test compares its files.
  writeFileSync(join(home, 'gitconfig'), '[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n')
  const git = (cwd: string, ...args: string[]): string => run('git', args, cwd, env)
  git(root, 'init', '-q', '--bare', origin)
  git(root, 'clone', '-q', origin, main)
  writeFileSync(join(main, '.gitignore'), 'build/\nout/\ndist/\nnode_modules/\n')
  writeFileSync(join(main, 'README'), 'base\n')
  git(main, 'add', '.')
  git(main, 'commit', '-q', '-m', 'base')
  git(main, 'push', '-q', 'origin', 'main')

  const commitOn = (cwd: string, file: string): string => {
    writeFileSync(join(cwd, file), `${file}\n`)
    git(cwd, 'add', file)
    git(cwd, 'commit', '-q', '-m', file)
    return git(cwd, 'rev-parse', 'HEAD')
  }
  const tips: Record<string, string> = {}
  for (const [dir, branch] of [['merged', 'feat/merged'], ['open', 'feat/open'], ['dirty', 'feat/dirty']] as const) {
    git(main, 'worktree', 'add', '-q', '-b', branch, join(wt, dir), 'main')
    tips[branch] = commitOn(join(wt, dir), `${dir}.txt`)
  }
  git(main, 'worktree', 'add', '-q', '-b', 'feat/stale', join(wt, 'stale'), 'main')
  tips['feat/stale'] = commitOn(join(wt, 'stale'), 'stale.txt')
  git(main, 'push', '-q', 'origin', 'feat/merged', 'feat/open', 'feat/stale')
  mkdirSync(join(wt, 'merged', 'build'))
  writeFileSync(join(wt, 'merged', 'build', 'app.bin'), 'x')
  writeFileSync(join(wt, 'dirty', 'notes.txt'), 'uncommitted\n')
  mkdirSync(join(wt, 'orphan'))
  for (const [branch, file] of [['feat/base', 'base.txt'], ['feat/unmerged', 'unmerged.txt'], ['feat/old-merged', 'old.txt'], ['feat/moved', 'moved.txt']] as const) {
    git(main, 'checkout', '-q', '-b', branch, 'main')
    tips[branch] = commitOn(main, file)
  }
  git(main, 'push', '-q', 'origin', 'feat/moved')
  git(main, 'checkout', '-q', '-b', 'feat/current', 'main')
  tips['feat/current'] = commitOn(main, 'current.txt')
  git(main, 'branch', '-q', '-D', 'feat/moved')
  const other = join(root, 'other')
  git(root, 'clone', '-q', '-b', 'feat/moved', origin, other)
  tips['moved-on-origin'] = commitOn(other, 'later.txt')
  // Someone deletes origin/feat/stale after the main checkout last fetched.
  git(other, 'push', '-q', 'origin', '--delete', 'feat/stale')

  mkdirSync(join(main, 'out'))
  writeFileSync(join(main, 'out', 'big.bin'), 'x'.repeat(4096))
  for (const d of ['dist', 'node_modules']) {
    mkdirSync(join(main, d))
    writeFileSync(join(main, d, 'keep.js'), 'x')
  }
  ageTree(root, env)

  // Made now, so recent: a worktree whose PR merged, but which someone may still be using.
  git(main, 'worktree', 'add', '-q', '-b', 'feat/recent', join(wt, 'recent'), 'main')
  tips['feat/recent'] = commitOn(join(wt, 'recent'), 'recent.txt')

  const pr = (n: number, state: string, head: string, oid: string, base = 'main'): string =>
    [n, state, head, oid, base].join('\t')
  writeFileSync(
    prs,
    [
      pr(1, 'MERGED', 'feat/merged', tips['feat/merged']!),
      pr(2, 'OPEN', 'feat/open', tips['feat/open']!),
      pr(3, 'MERGED', 'feat/dirty', tips['feat/dirty']!),
      pr(4, 'MERGED', 'feat/recent', tips['feat/recent']!),
      pr(5, 'MERGED', 'feat/current', tips['feat/current']!),
      pr(6, 'OPEN', 'feat/top', '0'.repeat(40), 'feat/base'),
      pr(7, 'MERGED', 'feat/base', tips['feat/base']!),
      pr(8, 'CLOSED', 'feat/old-merged', tips['feat/old-merged']!),
      pr(9, 'MERGED', 'feat/moved', tips['feat/moved']!),
    ].join('\n') + '\n',
  )
  return { root, main, wt, home, tmp, origin, env, prs, tips }
}

function sweep(f: Fixture, args: string[] = [], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync('bash', [SCRIPT, '--main', f.main, '--worktrees', f.wt, ...args], {
    cwd: f.root,
    env: { ...f.env, ...env },
    encoding: 'utf8',
    timeout: 100_000,
  })
}

/** key ("kind path-or-ref") -> the line's fields. */
function rows(stdout: string): Map<string, { checks: string; action: string; pr: string }> {
  const out = new Map<string, { checks: string; action: string; pr: string }>()
  for (const line of stdout.split('\n')) {
    if (line === '' || line.startsWith('#') || line.startsWith('kind\t')) continue
    const [kind, key, , , pr, checks, action] = line.split('\t')
    out.set(`${kind} ${key}`, { checks: checks!, action: action!, pr: pr! })
  }
  return out
}

function action(stdout: string, key: string): string | undefined {
  return rows(stdout).get(key)?.action
}

/** Everything a sweep could change: refs (local and origin), worktrees, and every path with its mtime. */
function state(f: Fixture): string {
  const git = (cwd: string, ...args: string[]): string => run('git', args, cwd, f.env)
  const listing: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      const st = lstatSync(p)
      listing.push(`${relative(f.root, p)} ${st.isDirectory() ? 'd' : st.size} ${st.mtimeMs}`)
      if (st.isDirectory()) walk(p)
    }
  }
  walk(f.root)
  return [
    git(f.main, 'for-each-ref'),
    git(f.origin, 'for-each-ref'),
    git(f.main, 'worktree', 'list', '--porcelain'),
    ...listing.filter((l) => !l.startsWith('gh.log ')),
  ].join('\n')
}

describe('workspace-sweep.sh (#248)', () => {
  it('proposes the merged worktree, its branches and old outputs, and keeps the rest with a reason', () => {
    const f = fixture()
    const r = sweep(f)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const out = r.stdout
    const wt = (d: string): string => `worktree ${join(f.wt, d)}`

    expect(action(out, wt('merged'))).toBe('remove')
    expect(rows(out).get(wt('merged'))?.checks).toContain('b')
    expect(rows(out).get(wt('merged'))?.pr).toBe('#1 MERGED')
    expect(action(out, 'branch feat/merged')).toBe('remove (after its worktree)')
    expect(action(out, 'remote origin/feat/merged')).toBe('remove')
    expect(action(out, 'branch feat/old-merged')).toBe('remove')
    expect(action(out, `build ${join(f.main, 'out')}`)).toBe('remove')

    expect(action(out, wt('open'))).toBe('keep: open PR #2')
    expect(action(out, 'remote origin/feat/open')).toBe('keep: open PR #2')
    expect(action(out, wt('dirty'))).toBe('keep: uncommitted changes')
    expect(action(out, wt('recent'))).toBe('keep: changed in the last 2 h')
    expect(action(out, wt('orphan'))).toBe('keep: not a git worktree')
    expect(action(out, 'branch feat/current')).toBe('keep: current branch of the main checkout')
    expect(action(out, 'branch main')).toBe('keep: main')
    expect(action(out, 'branch feat/open')).toBe(`keep: checked out in ${join(f.wt, 'open')}`)
    expect(action(out, 'branch feat/dirty')).toBe(`keep: checked out in ${join(f.wt, 'dirty')}`)
    expect(action(out, 'branch feat/base')).toBe('keep: base of open PR #6')
    expect(action(out, 'branch feat/unmerged')).toBe('keep: unmerged (no safety check passed)')
    expect(rows(out).get('branch feat/unmerged')?.checks).toBe('-')
    expect(action(out, 'remote origin/feat/moved')).toBe('remove')
    // The dry run reads refs as they are: only the stale origin/feat/stale vouches for it.
    expect(rows(out).get(wt('stale'))).toMatchObject({ checks: 'd', action: 'remove' })

    expect([...rows(out).keys()].some((k) => /\/(dist|node_modules)$/.test(k))).toBe(false)
    expect(out).toMatch(/^# remote-tracking refs: last fetched .*may be stale \(pass --fetch to refresh\)$/m)
    expect(out).toMatch(/^# summary: remove 8 \(3 branch, 1 build, 2 remote, 2 worktree\), keep \d+, reclaimable \S+$/m)
    // One line per candidate with seven tab-separated fields.
    for (const line of out.split('\n').filter((l) => l !== '' && !l.startsWith('#'))) {
      expect(line.split('\t')).toHaveLength(7)
    }
  }, TEST_TIMEOUT_MS)

  it('changes nothing in a dry run', () => {
    const f = fixture()
    const before = state(f)
    const r = sweep(f)
    expect(r.status).toBe(0)
    expect(state(f)).toBe(before)
  }, TEST_TIMEOUT_MS)

  it('--apply removes only the remove candidates and refuses a remote branch whose tip moved', () => {
    const f = fixture()
    // feat/moved moves on origin after the listing, just before the deletions.
    const r = sweep(f, ['--apply'], { FAKE_GH_ON_SECOND: `git -C '${join(f.root, 'other')}' push -q origin feat/moved` })
    expect(r.status).toBe(0)
    expect(action(r.stdout, 'remote origin/feat/moved')).toBe('remove')
    const git = (cwd: string, ...args: string[]): string => run('git', args, cwd, f.env)
    const local = git(f.main, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').sort()
    expect(local).toEqual(['feat/base', 'feat/current', 'feat/dirty', 'feat/open', 'feat/recent', 'feat/stale', 'feat/unmerged', 'main'])
    const remote = git(f.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').sort()
    expect(remote).toEqual(['feat/moved', 'feat/open', 'main'])
    expect(git(f.origin, 'rev-parse', 'refs/heads/feat/moved')).toBe(f.tips['moved-on-origin'])
    expect(r.stdout).toMatch(/^# apply: kept remote origin\/feat\/moved: remote tip changed/m)

    expect(existsSync(join(f.wt, 'merged'))).toBe(false)
    for (const d of ['open', 'dirty', 'recent', 'orphan', 'stale']) expect(existsSync(join(f.wt, d))).toBe(true)
    expect(existsSync(join(f.wt, 'dirty', 'notes.txt'))).toBe(true)
    expect(existsSync(join(f.main, 'out'))).toBe(false)
    expect(existsSync(join(f.main, 'dist', 'keep.js'))).toBe(true)
    expect(existsSync(join(f.main, 'node_modules', 'keep.js'))).toBe(true)
    expect(git(f.main, 'worktree', 'list', '--porcelain')).not.toContain(join(f.wt, 'merged'))
    expect(r.stdout).toMatch(/^# apply: removed 5, kept 1 on re-verification$/m)
  }, TEST_TIMEOUT_MS)

  it('--apply fetches first, so a remote branch deleted on origin no longer vouches for local work', () => {
    const f = fixture()
    const git = (cwd: string, ...args: string[]): string => run('git', args, cwd, f.env)
    const stale = join(f.wt, 'stale')
    const r = sweep(f, ['--apply'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('# remote-tracking refs: fetched now (--apply implies --fetch)')
    expect(rows(r.stdout).get(`worktree ${stale}`)).toMatchObject({ checks: '-', action: 'keep: unmerged (no safety check passed)' })
    expect(action(r.stdout, 'branch feat/stale')).toBe(`keep: checked out in ${stale}`)
    expect(existsSync(join(stale, 'stale.txt'))).toBe(true)
    expect(git(f.main, 'rev-parse', 'refs/heads/feat/stale')).toBe(f.tips['feat/stale'])
    expect(git(f.main, 'for-each-ref', 'refs/remotes/origin/feat/stale')).toBe('')

    // A fetch that fails stops --apply before it lists or removes anything. (Git itself
    // truncates FETCH_HEAD when a fetch fails.)
    const settled = (): string => state(f).replace(/^main\/\.git\/FETCH_HEAD .*\n/m, '')
    const before = settled()
    const away = join(f.root, 'origin-away.git')
    renameSync(f.origin, away)
    const broken = sweep(f, ['--apply'])
    renameSync(away, f.origin)
    expect(broken.status).toBe(2)
    expect(broken.stderr).toContain('git fetch --prune origin failed')
    expect(broken.stdout).toBe('')
    expect(settled()).toBe(before)
  }, TEST_TIMEOUT_MS)

  it('fails closed with exit 2 when gh fails, before listing or removing anything', () => {
    const f = fixture()
    const before = state(f)
    const r = sweep(f, ['--apply'], { FAKE_GH_EXIT: '1' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('failing closed')
    expect(r.stdout).toBe('')
    expect(state(f)).toBe(before)
  }, TEST_TIMEOUT_MS)

  it('keeps a worktree that a running process names', () => {
    const f = fixture()
    const merged = join(f.wt, 'merged')
    const named = spawn('sh', ['-c', 'sleep 60; : "$0"', merged], { stdio: 'ignore' })
    try {
      const r = sweep(f)
      expect(action(r.stdout, `worktree ${merged}`)).toBe('keep: in use by a running process')
      expect(action(r.stdout, 'branch feat/merged')).toBe(`keep: checked out in ${merged}`)
    } finally {
      named.kill()
    }
  }, TEST_TIMEOUT_MS)

  it('refuses unknown arguments with exit 64', () => {
    const f = fixture()
    const r = sweep(f, ['--force'])
    expect(r.status).toBe(64)
  }, TEST_TIMEOUT_MS)

  it('sweeps only old $TMPDIR entries named <prefix>XXXXXX with a derived prefix, inside the resolved $TMPDIR', () => {
    const f = fixture()
    const outside = join(f.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious'), 'x')
    const make = (name: string): void => {
      mkdirSync(join(f.tmp, name))
      writeFileSync(join(f.tmp, name, 'f'), 'x')
    }
    for (const name of ['inbox-dom-Ab12Cd', 'unrelated-Ab12Cd', 'inbox-dom-TooLong1', 'repo-Ab12Cd']) make(name)
    symlinkSync(outside, join(f.tmp, 'inbox-dom-Lnk123'))
    ageTree(f.tmp, f.env)
    make('inbox-dom-Zz9999')
    // Reached through a symlink: entries are reported and removed by their resolved path.
    const link = join(f.root, 'tmp-link')
    symlinkSync(f.tmp, link)

    const dry = sweep(f, [], { TMPDIR: link })
    expect(dry.status).toBe(0)
    expect(dry.stdout).toMatch(/^# temp prefixes \(\d+\):.* inbox-dom- /m)
    expect(dry.stdout).toMatch(/^# refused prefixes \(too generic\):.* repo-( |$)/m)
    expect(dry.stdout).toContain(`# temp folder: ${f.tmp}\n`)
    const temps = [...rows(dry.stdout).entries()].filter(([k]) => k.startsWith('temp '))
    expect(Object.fromEntries(temps.map(([k, v]) => [k, v.action]))).toEqual({
      [`temp ${join(f.tmp, 'inbox-dom-Ab12Cd')}`]: 'remove',
      [`temp ${join(f.tmp, 'inbox-dom-Lnk123')}`]: 'keep: symlink',
      [`temp ${join(f.tmp, 'inbox-dom-Zz9999')}`]: 'keep: changed in the last 2 h',
    })

    // A $TMPDIR that holds home or the main checkout is not swept at all.
    const wide = sweep(f, ['--apply'], { TMPDIR: f.root })
    expect(wide.status).toBe(0)
    expect(wide.stdout).toContain('# temp folder: not swept')
    expect(wide.stdout).not.toMatch(/^temp\t/m)
    expect(existsSync(join(f.tmp, 'inbox-dom-Ab12Cd'))).toBe(true)

    const r = sweep(f, ['--apply'], { TMPDIR: link })
    expect(r.status).toBe(0)
    expect(readdirSync(f.tmp).sort()).toEqual(['inbox-dom-Lnk123', 'inbox-dom-TooLong1', 'inbox-dom-Zz9999', 'repo-Ab12Cd', 'unrelated-Ab12Cd'])
    expect(readlinkSync(join(f.tmp, 'inbox-dom-Lnk123'))).toBe(outside)
    expect(existsSync(join(outside, 'precious'))).toBe(true)
  }, TEST_TIMEOUT_MS)

  it('reads remote-tracking refs as they are, and fetches only with --fetch', () => {
    const f = fixture()
    const git = (cwd: string, ...args: string[]): string => run('git', args, cwd, f.env)
    git(join(f.root, 'other'), 'push', '-q', 'origin', 'HEAD:refs/heads/feat/late')

    const dry = sweep(f)
    expect(rows(dry.stdout).has('remote origin/feat/late')).toBe(false)
    expect(git(f.main, 'for-each-ref', 'refs/remotes/origin/feat/late')).toBe('')

    const fetched = sweep(f, ['--fetch'])
    expect(fetched.status).toBe(0)
    expect(fetched.stdout).toContain('# remote-tracking refs: fetched now (--fetch)')
    expect(action(fetched.stdout, 'remote origin/feat/late')).toBe('keep: tip is not the head of a merged or closed PR')
    expect(action(fetched.stdout, `worktree ${join(f.wt, 'stale')}`)).toBe('keep: unmerged (no safety check passed)')
  }, TEST_TIMEOUT_MS)
})
