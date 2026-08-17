// test/stamp.test.ts — issue #40, the build stamp and the staleness verdict.
//
// The bug this exists for: a packaged .app served a build four features behind
// while its window looked entirely normal. Nothing anywhere said which build was
// running. `scripts/write-setup-info.mjs` bakes the commit; this module reads the
// checkout's CURRENT head in the VIEWER process and compares the two.
//
// Every test below uses REAL temp git repos (the idiom of test/infer.test.ts) —
// the ancestry verdicts are `git merge-base --is-ancestor` answers, not a mock's.
// The injected `git` runner is used only for the paths a real repo cannot stage:
// git missing entirely, and counting probes to prove the cache.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  buildStamp, execGit, readBakedInfo, STAMP_TTL_MS,
  type BakedInfo, type GitRun, type StampCache,
} from '../src/stamp.js'

const REPO = new URL('..', import.meta.url).pathname

// ── real git fixtures ───────────────────────────────────────────────────────

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  return dir
}

function commitIn(dir: string, msg: string): string {
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', msg], { cwd: dir })
  return head(dir)
}

function head(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
}

function baked(dir: string, commit: string): BakedInfo {
  return { repoRoot: dir, nodeBin: '/usr/bin/node', commit, builtAt: '2026-07-25T12:00:00.000Z' }
}

/** A runner that counts probes and can be told git does not exist at all. */
function countingGit(answer: 'missing' | 'real' = 'real'): GitRun & { calls: string[][] } {
  const calls: string[][] = []
  const run = (async (cwd: string, args: string[]) => {
    calls.push(args)
    return answer === 'missing' ? null : await execGit(cwd, args)
  }) as GitRun & { calls: string[][] }
  run.calls = calls
  return run
}

const fresh = (): { cache: StampCache } => ({ cache: new Map() })

// ── the dev path: a checkout, nothing baked ─────────────────────────────────

describe('buildStamp · the dev path has no baked commit and must not claim staleness', () => {
  it('reports the checkout\'s live HEAD and drift "dev"', async () => {
    const dir = tmpRepo()
    const sha = commitIn(dir, 'one')

    const stamp = await buildStamp(null, dir, fresh())

    expect(stamp.drift).toBe('dev')
    expect(stamp.head).toBe(sha)
    expect(stamp.commit).toBeNull()
    expect(stamp.builtAt).toBeNull()
    expect(stamp.repoRoot).toBe(dir)
  })

  it('says nothing at all when the cwd is not a git checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))

    const stamp = await buildStamp(null, dir, fresh())

    expect(stamp).toMatchObject({ drift: 'dev', head: null, commit: null })
  })
})

// ── the packaged path: baked commit vs the checkout's HEAD ──────────────────

describe('buildStamp · a packaged bundle against its checkout', () => {
  it('is "current" when the checkout still sits on the baked commit', async () => {
    const dir = tmpRepo()
    const a = commitIn(dir, 'one')

    const stamp = await buildStamp(baked(dir, a), '/somewhere/else', fresh())

    expect(stamp.drift).toBe('current')
    expect(stamp.commit).toBe(a)
    expect(stamp.head).toBe(a)
    expect(stamp.builtAt).toBe('2026-07-25T12:00:00.000Z')
  })

  it('is "stale" when the checkout has moved ON past the baked commit', async () => {
    const dir = tmpRepo()
    const a = commitIn(dir, 'one')
    const b = commitIn(dir, 'two')

    const stamp = await buildStamp(baked(dir, a), '/x', fresh())

    expect(stamp.drift).toBe('stale')
    expect(stamp.head).toBe(b)
  })

  it('is "behind" — NOT stale — when the checkout has been moved BACK', async () => {
    // the human checked out an older commit/branch; the app is ahead of the
    // checkout, so there is nothing to repackage. A different sentence.
    const dir = tmpRepo()
    const a = commitIn(dir, 'one')
    const b = commitIn(dir, 'two')
    execFileSync('git', ['checkout', '-q', a], { cwd: dir })

    const stamp = await buildStamp(baked(dir, b), '/x', fresh())

    expect(stamp.drift).toBe('behind')
    expect(stamp.head).toBe(a)
  })

  it('is "diverged" when neither commit is an ancestor of the other', async () => {
    const dir = tmpRepo()
    const a = commitIn(dir, 'one')
    const b = commitIn(dir, 'two')
    execFileSync('git', ['checkout', '-q', '-b', 'side', a], { cwd: dir })
    const c = commitIn(dir, 'side work')

    const stamp = await buildStamp(baked(dir, b), '/x', fresh())

    expect(stamp.drift).toBe('diverged')
    expect(stamp.head).toBe(c)
  })

  it('is "diverged" — never "stale" — for a commit the checkout has never heard of', async () => {
    const dir = tmpRepo()
    commitIn(dir, 'one')

    const stamp = await buildStamp(baked(dir, '0'.repeat(40)), '/x', fresh())

    expect(stamp.drift).toBe('diverged')
  })
})

// ── fail open, absolutely ───────────────────────────────────────────────────

describe('buildStamp · fails open on every broken input', () => {
  it('a moved or deleted checkout yields "unknown" and keeps the stamp itself', async () => {
    const dir = tmpRepo()
    const a = commitIn(dir, 'one')
    rmSync(dir, { recursive: true, force: true })

    const stamp = await buildStamp(baked(dir, a), '/x', fresh())

    expect(stamp.drift).toBe('unknown')
    expect(stamp.head).toBeNull()
    expect(stamp.commit).toBe(a)          // still answers "which build is this"
    expect(stamp.builtAt).toBe('2026-07-25T12:00:00.000Z')
  })

  it('no git at all yields "unknown", packaged or not', async () => {
    const dir = tmpRepo()
    const a = commitIn(dir, 'one')
    const gone = countingGit('missing')

    expect(await buildStamp(baked(dir, a), '/x', { ...fresh(), git: gone })).toMatchObject({ drift: 'unknown', head: null })
    expect(await buildStamp(null, dir, { ...fresh(), git: gone })).toMatchObject({ drift: 'dev', head: null })
  })

  it('a bundle packaged before #40 (repoRoot but no commit) reads as "unknown" and probes nothing', async () => {
    const dir = tmpRepo()
    commitIn(dir, 'one')
    const git = countingGit()

    const stamp = await buildStamp({ repoRoot: dir, nodeBin: '/n' }, '/x', { ...fresh(), git })

    expect(stamp).toMatchObject({ drift: 'unknown', commit: null, head: null })
    expect(git.calls, 'nothing to compare against — do not spawn git').toEqual([])
  })

  it('a baked commit that is not a plausible sha is dropped and never handed to git', async () => {
    const dir = tmpRepo()
    commitIn(dir, 'one')
    const git = countingGit()

    const stamp = await buildStamp({ repoRoot: dir, commit: '--upload-pack=touch /tmp/pwned' }, '/x', { ...fresh(), git })

    expect(stamp).toMatchObject({ drift: 'unknown', commit: null })
    expect(git.calls).toEqual([])
  })

  it('an absent repoRoot never spawns git', async () => {
    const git = countingGit()
    const stamp = await buildStamp({ commit: 'a'.repeat(40) }, '/x', { ...fresh(), git })
    expect(stamp).toMatchObject({ drift: 'unknown', repoRoot: null })
    expect(git.calls).toEqual([])
  })

  it('a hanging git is bounded by a timeout rather than hanging the viewer', async () => {
    const started = Date.now()
    const out = await execGit(tmpdir(), ['30'], '/bin/sleep', 150)
    expect(out).toBeNull()
    expect(Date.now() - started, 'execGit ignored its timeout').toBeLessThan(5000)
  })

  it('a garbage builtAt is dropped, not rendered', async () => {
    const dir = tmpRepo()
    const a = commitIn(dir, 'one')
    const stamp = await buildStamp({ repoRoot: dir, commit: a, builtAt: 'not a date' }, '/x', fresh())
    expect(stamp.builtAt).toBeNull()
    expect(stamp.drift).toBe('current')
  })
})

// ── issue #74: a signed release build makes NO checkout/repackage claim ─────

describe('buildStamp · a release build (schema 2) is a third case, never dev/current/stale', () => {
  it('short-circuits to drift "release" with version/commit/builtAt, no head, no git spawn', async () => {
    const git = countingGit()
    const releaseBaked: BakedInfo = {
      schema: 2,
      version: '1.2.3',
      commit: 'a'.repeat(40),
      builtAt: '2026-07-25T12:00:00.000Z',
      runtimePayloads: {
        'darwin-arm64': { path: 'runtime/darwin-arm64.tar.gz', digest: `sha256:${'b'.repeat(64)}` },
        'darwin-x64': { path: 'runtime/darwin-x64.tar.gz', digest: `sha256:${'c'.repeat(64)}` },
      },
    }

    const stamp = await buildStamp(releaseBaked, '/some/cwd', { ...fresh(), git })

    expect(stamp.drift).toBe('release')
    expect(stamp.version).toBe('1.2.3')
    expect(stamp.commit).toBe('a'.repeat(40))
    expect(stamp.builtAt).toBe('2026-07-25T12:00:00.000Z')
    expect(stamp.head).toBeNull()
    expect(stamp.repoRoot).toBeNull()
    expect(git.calls, 'a release has no builder checkout to probe').toEqual([])
  })

  it('never claims repoRoot/nodeBin exist for a release build even if hand-added to the baked JSON', async () => {
    const stamp = await buildStamp(
      { schema: 2, version: '9.9.9', repoRoot: '/builder/machine/checkout' } as BakedInfo,
      '/x',
      fresh(),
    )
    expect(stamp.drift).toBe('release')
    expect(stamp.repoRoot).toBeNull()
  })

  it('reports version: null for dev and legacy (pre-#74) bundles', async () => {
    const dir = tmpRepo()
    commitIn(dir, 'one')
    expect((await buildStamp(null, dir, fresh())).version).toBeNull()
    expect((await buildStamp({ repoRoot: dir, nodeBin: '/n' }, '/x', fresh())).version).toBeNull()
  })
})

describe('readBakedInfo · a corrupt setup-info.json can never break the viewer', () => {
  const write = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'baked-'))
    const p = join(dir, 'setup-info.json')
    writeFileSync(p, body)
    return p
  }

  it('returns null for a missing file', () => {
    expect(readBakedInfo(join(tmpdir(), 'nope-40', 'setup-info.json'))).toBeNull()
  })

  it('returns null for unparseable JSON', () => {
    expect(readBakedInfo(write('{ not json'))).toBeNull()
  })

  it('returns null for JSON that is not an object', () => {
    expect(readBakedInfo(write('[1,2,3]'))).toBeNull()
    expect(readBakedInfo(write('"hello"'))).toBeNull()
  })

  it('drops fields of the wrong type instead of trusting them', () => {
    const info = readBakedInfo(write(JSON.stringify({ repoRoot: 42, nodeBin: null, commit: { a: 1 }, builtAt: 7 })))
    expect(info).toEqual({})
  })

  it('reads the real shape the packager writes', () => {
    const info = readBakedInfo(write(JSON.stringify({ repoRoot: '/r', nodeBin: '/n', commit: 'abc123', builtAt: '2026-07-25T12:00:00.000Z' })))
    expect(info).toEqual({ repoRoot: '/r', nodeBin: '/n', commit: 'abc123', builtAt: '2026-07-25T12:00:00.000Z' })
  })

  // issue #74 — the release shape write-setup-info.mjs --release bakes.
  it('reads a release bake (schema 2, version, runtimePayloads) with no repoRoot/nodeBin', () => {
    const info = readBakedInfo(write(JSON.stringify({
      schema: 2,
      version: '1.0.0',
      builtAt: '2026-07-25T12:00:00.000Z',
      commit: 'a'.repeat(40),
      runtimePayloads: {
        'darwin-arm64': { path: 'runtime/darwin-arm64.tar.gz', digest: `sha256:${'b'.repeat(64)}` },
        'darwin-x64': { path: 'runtime/darwin-x64.tar.gz', digest: `sha256:${'c'.repeat(64)}` },
      },
    })))
    expect(info).toEqual({
      schema: 2,
      version: '1.0.0',
      builtAt: '2026-07-25T12:00:00.000Z',
      commit: 'a'.repeat(40),
      runtimePayloads: {
        'darwin-arm64': { path: 'runtime/darwin-arm64.tar.gz', digest: `sha256:${'b'.repeat(64)}` },
        'darwin-x64': { path: 'runtime/darwin-x64.tar.gz', digest: `sha256:${'c'.repeat(64)}` },
      },
    })
    expect(info!.repoRoot).toBeUndefined()
    expect(info!.nodeBin).toBeUndefined()
  })

  it('drops malformed runtimePayloads entries instead of trusting them', () => {
    const info = readBakedInfo(write(JSON.stringify({
      schema: 2,
      version: '1.0.0',
      runtimePayloads: {
        'darwin-arm64': { path: 'runtime/darwin-arm64.tar.gz', digest: `sha256:${'b'.repeat(64)}` },
        'darwin-x64': { path: 123, digest: null },
        junk: 'not-an-object',
      },
    })))
    expect(info!.runtimePayloads).toEqual({
      'darwin-arm64': { path: 'runtime/darwin-arm64.tar.gz', digest: `sha256:${'b'.repeat(64)}` },
    })
  })
})

// ── cadence: git runs on a cache, not on every request ──────────────────────

describe('buildStamp · the git probe is memoized, never per-request', () => {
  it('answers a second call from cache', async () => {
    const dir = tmpRepo()
    const a = commitIn(dir, 'one')
    const git = countingGit()
    const opts = { ...fresh(), git }

    const first = await buildStamp(baked(dir, a), '/x', opts)
    const calls = git.calls.length
    const second = await buildStamp(baked(dir, a), '/x', opts)

    expect(calls).toBeGreaterThan(0)
    expect(git.calls.length, 'shelled out to git again inside the TTL').toBe(calls)
    expect(second).toEqual(first)
  })

  it('re-probes once the TTL has passed', async () => {
    const dir = tmpRepo()
    const a = commitIn(dir, 'one')
    const git = countingGit()
    let t = 1_000_000
    const opts = { cache: new Map() as StampCache, git, now: () => t }

    await buildStamp(baked(dir, a), '/x', opts)
    const calls = git.calls.length
    t += STAMP_TTL_MS + 1
    await buildStamp(baked(dir, a), '/x', opts)

    expect(git.calls.length).toBeGreaterThan(calls)
  })

  it('picks the checkout moving on up on the next probe', async () => {
    const dir = tmpRepo()
    const a = commitIn(dir, 'one')
    let t = 1_000_000
    const opts = { cache: new Map() as StampCache, now: () => t }

    expect((await buildStamp(baked(dir, a), '/x', opts)).drift).toBe('current')
    commitIn(dir, 'two')
    t += STAMP_TTL_MS + 1
    expect((await buildStamp(baked(dir, a), '/x', opts)).drift).toBe('stale')
  })
})

// ── the stdio invariant ─────────────────────────────────────────────────────

describe('the git subprocess CAPTURES stdout', () => {
  it('a child process that runs execGit prints nothing of its own', () => {
    // A REAL spawn: if execGit ever inherited stdout, git's sha would land on
    // this child's stdout and the assertion below would see it. That is exactly
    // what would corrupt the MCP wire if this module were ever imported there.
    const dir = mkdtempSync(join(tmpdir(), 'capture-'))
    // .mts, not .ts: the file lives outside the repo, so tsx has no
    // "type":"module" nearby and would compile a bare .ts to CJS (no top-level await).
    const script = join(dir, 'probe.mts')
    writeFileSync(script, [
      `import { execGit } from ${JSON.stringify(join(REPO, 'src/stamp.ts'))}`,
      `const ok = await execGit(process.argv[2]!, ['rev-parse', 'HEAD'])`,
      `const bad = await execGit(process.argv[2]!, ['rev-parse', 'nope-40'])`,
      `process.stderr.write(JSON.stringify({ ok: ok?.code, bad: bad?.code }))`,
    ].join('\n'))
    const repo = tmpRepo()
    commitIn(repo, 'one')

    const out = execFileSync('npx', ['tsx', script, repo], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })

    expect(out, 'the git subprocess leaked onto the parent stdout').toBe('')
  })
})

// ── tenet 2: a stale build is NOT the human being blocked ───────────────────

describe('the build stamp never enters the attention set', () => {
  const read = (p: string): string => readFileSync(join(REPO, p), 'utf8')

  it('public/attention.js knows nothing about builds, commits or drift', () => {
    const src = read('public/attention.js')
    for (const token of ['drift', 'commit', 'builtAt', 'buildstamp', 'buildSummary', 'package:app', 'api/setup']) {
      expect(src, `attention.js mentions ${token}`).not.toContain(token)
    }
  })

  it('public/badge.js knows nothing about it either', () => {
    const src = read('public/badge.js')
    for (const token of ['drift', 'builtAt', 'buildSummary', 'package:app']) {
      expect(src, `badge.js mentions ${token}`).not.toContain(token)
    }
  })

  it('the Electron dock badge never fetches the setup endpoint', () => {
    expect(read('electron/main.cjs')).not.toContain('api/setup')
  })

  it('the stdio MCP server never imports the stamp module', () => {
    for (const f of ['src/mcp.ts', 'src/mcp-server.ts', 'src/hook.ts', 'src/hook-cli.ts']) {
      expect(read(f), `${f} imports stamp.js`).not.toContain('stamp.js')
    }
  })
})
