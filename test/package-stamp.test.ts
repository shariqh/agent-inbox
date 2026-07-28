// test/package-stamp.test.ts — issue #40, the BAKE side of the build stamp.
//
// `scripts/package-app.sh` cannot be run in a test (it npm-installs, rebuilds a
// native module for Electron's ABI and packages a .app), so the one part of it
// that has to be right — what it writes into setup-info.json — was lifted into
// `scripts/write-setup-info.mjs` and is executed here FOR REAL: a real child
// process, over real temp git repos, with git really removed from its PATH.
//
// The rule the issue states: read the SHA from git, and if git is unavailable the
// field must be ABSENT rather than wrong. A wrong commit is worse than no commit —
// it would make the viewer claim "up to date" about a build it knows nothing about.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = new URL('..', import.meta.url).pathname
const SCRIPT = join(REPO, 'scripts', 'write-setup-info.mjs')

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bake-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

/** Run the real script in a real child process. `env` is the CHILD's only. */
function bake(root: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const out = join(mkdtempSync(join(tmpdir(), 'stage-')), 'setup-info.json')
  const stdout = execFileSync(process.execPath, [SCRIPT, root, out], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
  })
  expect(stdout, 'the packager step must stay quiet').toBe('')
  return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>
}

describe('scripts/write-setup-info.mjs bakes what the bundle was built from', () => {
  it('stamps the commit and the build time alongside the paths it already wrote', () => {
    const root = tmpRepo()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()

    const info = bake(root)

    expect(info['repoRoot']).toBe(root)
    expect(info['nodeBin']).toBe(process.execPath)
    expect(info['commit']).toBe(head)
    expect(String(info['commit'])).toMatch(/^[0-9a-f]{40}$/)
    const builtAt = Date.parse(String(info['builtAt']))
    expect(Number.isFinite(builtAt)).toBe(true)
    expect(Math.abs(Date.now() - builtAt), 'builtAt is not the build time').toBeLessThan(60_000)
  })

  it('OMITS the commit rather than guessing when the root is not a git checkout', () => {
    const info = bake(mkdtempSync(join(tmpdir(), 'plain-')))

    expect('commit' in info, 'a wrong commit is worse than none').toBe(false)
    expect(info['nodeBin']).toBe(process.execPath)
    expect(typeof info['builtAt']).toBe('string')
  })

  it('OMITS the commit when git is not installed at all', () => {
    const root = tmpRepo()

    const info = bake(root, { ...process.env, PATH: join(tmpdir(), 'no-git-here-40') })

    expect('commit' in info).toBe(false)
    expect(info['repoRoot']).toBe(root)
  })
})

describe('the packager delegates to it', () => {
  const sh = readFileSync(join(REPO, 'scripts', 'package-app.sh'), 'utf8')

  it('package-app.sh calls the script instead of writing setup-info.json inline', () => {
    expect(sh).toContain('write-setup-info.mjs')
    // the old inline `node -e` heredoc wrote the file itself; exactly one writer now
    expect(sh).not.toContain("writeFileSync('$STAGE/setup-info.json'")
  })

  it('stamps the STAGED copy, from the repo root it also bakes as repoRoot', () => {
    expect(sh).toMatch(/write-setup-info\.mjs" "\$ROOT" "\$STAGE\/setup-info\.json"/)
  })
})
