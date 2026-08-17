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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = new URL('..', import.meta.url).pathname
const SCRIPT = join(REPO, 'scripts', 'write-setup-info.mjs')
const PAYLOAD_CLI = join(REPO, 'scripts', 'runtime-payload.mjs')

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

  it('uses SOURCE_DATE_EPOCH for reproducible package metadata', () => {
    const info = bake(tmpRepo(), { ...process.env, SOURCE_DATE_EPOCH: '1767225600' })
    expect(info['builtAt']).toBe('2026-01-01T00:00:00.000Z')
  })
})

// issue #74 — RELEASE mode bakes architecture-keyed runtime metadata instead
// of a builder checkout path. Run the real script for real, exactly like the
// dev-mode suite above: a real child process, real staged files, real SHA-256.
//
// The real payload (scripts/runtime-payload.mjs) is a DIRECTORY containing a
// `runtime-manifest.json` naming its own platform/arch — never a flat file.
function stagePayloadDir(
  dir: string,
  relDir: string,
  platform: string,
  arch: string,
  opts: {
    withManifest?: boolean
    product?: string
    packageVersion?: string
    platform?: string
    arch?: string
    nodeVersion?: string
    nodeModulesAbi?: string
    omitEntrypoint?: string
    omitFile?: string
  } = {},
): string {
  const full = join(dir, relDir)
  mkdirSync(full, { recursive: true })
  if (opts.withManifest === false) return full
  const files: Record<string, string> = {
    'dist/mcp-server.js': '// mcp\n',
    'dist/hook-cli.js': '// hook\n',
    'dist/watch-cli.js': '// watch\n',
    'scripts/install-agents.sh': '#!/bin/bash\n',
    'scripts/runtime-payload.mjs': '// verifier\n',
    'scripts/runtime-config.mjs': '// config\n',
  }
  for (const [path, contents] of Object.entries(files)) {
    if (path === opts.omitFile) continue
    mkdirSync(join(full, path, '..'), { recursive: true })
    writeFileSync(join(full, path), contents)
  }
  const entrypoints = ['dist/mcp-server.js', 'dist/hook-cli.js', 'dist/watch-cli.js']
    .filter((entry) => entry !== opts.omitEntrypoint && entry !== opts.omitFile)
  const args = [
    PAYLOAD_CLI,
    'manifest',
    '--root', full,
    '--product', opts.product ?? 'agent-inbox-runtime',
    '--package-version', opts.packageVersion ?? '1.2.3',
    '--source-commit', 'deadbeef',
    '--platform', opts.platform ?? platform,
    '--arch', opts.arch ?? arch,
    '--node-version', opts.nodeVersion ?? process.version,
    '--node-modules-abi', opts.nodeModulesAbi ?? process.versions.modules,
  ]
  for (const entrypoint of entrypoints) args.push('--entrypoint', entrypoint)
  execFileSync(process.execPath, args)
  return full
}

function bakeRelease(args: string[]): { code: number; stdout: string; stderr: string; out: string } {
  const out = join(mkdtempSync(join(tmpdir(), 'release-stage-')), 'setup-info.json')
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--release', out, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '', out }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    return { code: e.status, stdout: e.stdout, stderr: e.stderr, out }
  }
}

describe('scripts/write-setup-info.mjs --release (issue #74)', () => {
  it('emits schema/version/commit/builtAt and both mandatory runtimePayloads keys, with no repoRoot/nodeBin', () => {
    const payloadRoot = mkdtempSync(join(tmpdir(), 'payload-root-'))
    stagePayloadDir(payloadRoot, 'runtime/darwin-arm64', 'darwin', 'arm64')
    stagePayloadDir(payloadRoot, 'runtime/darwin-x64', 'darwin', 'x64')
    const sourceRoot = tmpRepo()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()

    const { code, stdout, out } = bakeRelease([
      '--version', '1.2.3',
      '--payload-root', payloadRoot,
      '--payload', 'darwin-arm64=runtime/darwin-arm64',
      '--payload', 'darwin-x64=runtime/darwin-x64',
      '--source-root', sourceRoot,
    ])
    expect(code).toBe(0)
    expect(stdout, 'the packager step must stay quiet').toBe('')

    const info = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>
    expect(info['schema']).toBe(2)
    expect(info['version']).toBe('1.2.3')
    expect(info['commit']).toBe(head)
    expect(typeof info['builtAt']).toBe('string')
    expect(Number.isFinite(Date.parse(String(info['builtAt'])))).toBe(true)
    expect('repoRoot' in info).toBe(false)
    expect('nodeBin' in info).toBe(false)
    expect('sourceRoot' in info, '--source-root is a build input only, never persisted').toBe(false)

    const arm = createHash('sha256').update(readFileSync(join(payloadRoot, 'runtime/darwin-arm64/runtime-manifest.json'))).digest('hex')
    const x64 = createHash('sha256').update(readFileSync(join(payloadRoot, 'runtime/darwin-x64/runtime-manifest.json'))).digest('hex')
    expect(info['runtimePayloads']).toEqual({
      'darwin-arm64': { path: 'runtime/darwin-arm64', digest: `sha256:${arm}` },
      'darwin-x64': { path: 'runtime/darwin-x64', digest: `sha256:${x64}` },
    })
    // every digest must be a validated, well-formed SHA-256
    for (const entry of Object.values(info['runtimePayloads'] as Record<string, { digest: string }>)) {
      expect(entry.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
  })

  it.each([
    ['wrong product', { product: 'other-runtime' }],
    ['package version mismatch', { packageVersion: '9.9.9' }],
    ['Node 23', { nodeVersion: 'v23.11.0' }],
    ['Node 25', { nodeVersion: 'v25.0.0' }],
    ['malformed ABI', { nodeModulesAbi: 'not-numeric' }],
    ['wrong ABI', { nodeModulesAbi: '999' }],
    ['missing MCP entrypoint', { omitEntrypoint: 'dist/mcp-server.js' }],
    ['missing hook entrypoint', { omitEntrypoint: 'dist/hook-cli.js' }],
    ['missing watch entrypoint', { omitEntrypoint: 'dist/watch-cli.js' }],
    ['missing installer', { omitFile: 'scripts/install-agents.sh' }],
    ['missing runtime verifier', { omitFile: 'scripts/runtime-payload.mjs' }],
    ['missing runtime config helper', { omitFile: 'scripts/runtime-config.mjs' }],
  ])('refuses release metadata for %s', (_label, override) => {
    const payloadRoot = mkdtempSync(join(tmpdir(), 'payload-root-identity-'))
    stagePayloadDir(payloadRoot, 'runtime/darwin-arm64', 'darwin', 'arm64', override)
    stagePayloadDir(payloadRoot, 'runtime/darwin-x64', 'darwin', 'x64')
    const result = bakeRelease([
      '--version', '1.2.3',
      '--payload-root', payloadRoot,
      '--payload', 'darwin-arm64=runtime/darwin-arm64',
      '--payload', 'darwin-x64=runtime/darwin-x64',
    ])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/identity\/integrity verification failed/i)
    expect(existsSync(result.out)).toBe(false)
  })

  it('rejects a partial runtimePayloads map — one missing mandatory key fails the whole bake', () => {
    const payloadRoot = mkdtempSync(join(tmpdir(), 'payload-root-partial-'))
    stagePayloadDir(payloadRoot, 'runtime/darwin-arm64', 'darwin', 'arm64')

    const { code, stderr } = bakeRelease([
      '--version', '1.0.0',
      '--payload-root', payloadRoot,
      '--payload', 'darwin-arm64=runtime/darwin-arm64',
    ])
    expect(code).not.toBe(0)
    expect(stderr).toMatch(/darwin-x64/)
  })

  it('rejects a --version-less invocation', () => {
    const payloadRoot = mkdtempSync(join(tmpdir(), 'payload-root-nover-'))
    stagePayloadDir(payloadRoot, 'runtime/darwin-arm64', 'darwin', 'arm64')
    stagePayloadDir(payloadRoot, 'runtime/darwin-x64', 'darwin', 'x64')
    const { code, stderr } = bakeRelease([
      '--payload-root', payloadRoot,
      '--payload', 'darwin-arm64=runtime/darwin-arm64',
      '--payload', 'darwin-x64=runtime/darwin-x64',
    ])
    expect(code).not.toBe(0)
    expect(stderr).toMatch(/--version/)
  })

  it('rejects an absolute or traversal payload path without writing anything', () => {
    const payloadRoot = mkdtempSync(join(tmpdir(), 'payload-root-bad-path-'))
    stagePayloadDir(payloadRoot, 'runtime/darwin-x64', 'darwin', 'x64')
    const { code, stderr, out } = bakeRelease([
      '--version', '1.0.0',
      '--payload-root', payloadRoot,
      '--payload', 'darwin-arm64=/etc/passwd',
      '--payload', 'darwin-x64=runtime/darwin-x64',
    ])
    expect(code).not.toBe(0)
    expect(stderr).toMatch(/relative, traversal-free/)
    expect(existsSync(out)).toBe(false)

    const traversal = bakeRelease([
      '--version', '1.0.0',
      '--payload-root', payloadRoot,
      '--payload', 'darwin-arm64=../outside',
      '--payload', 'darwin-x64=runtime/darwin-x64',
    ])
    expect(traversal.code).not.toBe(0)
  })

  it('rejects a payload directory that does not exist under --payload-root', () => {
    const payloadRoot = mkdtempSync(join(tmpdir(), 'payload-root-missing-'))
    stagePayloadDir(payloadRoot, 'runtime/darwin-x64', 'darwin', 'x64')
    const { code, stderr } = bakeRelease([
      '--version', '1.0.0',
      '--payload-root', payloadRoot,
      '--payload', 'darwin-arm64=runtime/does-not-exist',
      '--payload', 'darwin-x64=runtime/darwin-x64',
    ])
    expect(code).not.toBe(0)
    expect(stderr).toMatch(/no runtime payload directory staged/)
  })

  it('rejects a payload directory with no runtime-manifest.json', () => {
    const payloadRoot = mkdtempSync(join(tmpdir(), 'payload-root-no-manifest-'))
    stagePayloadDir(payloadRoot, 'runtime/darwin-arm64', 'darwin', 'arm64', { withManifest: false })
    stagePayloadDir(payloadRoot, 'runtime/darwin-x64', 'darwin', 'x64')
    const { code, stderr } = bakeRelease([
      '--version', '1.0.0',
      '--payload-root', payloadRoot,
      '--payload', 'darwin-arm64=runtime/darwin-arm64',
      '--payload', 'darwin-x64=runtime/darwin-x64',
    ])
    expect(code).not.toBe(0)
    expect(stderr).toMatch(/no runtime-manifest\.json staged/)
  })

  it("rejects a manifest whose platform/arch don't match its --payload map key", () => {
    const payloadRoot = mkdtempSync(join(tmpdir(), 'payload-root-mismatch-'))
    // Staged under darwin-arm64, but the manifest itself says x64 — a
    // build-time mix-up write-setup-info.mjs must not bake and trust.
    stagePayloadDir(payloadRoot, 'runtime/darwin-arm64', 'darwin', 'arm64', { arch: 'x64' })
    stagePayloadDir(payloadRoot, 'runtime/darwin-x64', 'darwin', 'x64')
    const { code, stderr } = bakeRelease([
      '--version', '1.0.0',
      '--payload-root', payloadRoot,
      '--payload', 'darwin-arm64=runtime/darwin-arm64',
      '--payload', 'darwin-x64=runtime/darwin-x64',
    ])
    expect(code).not.toBe(0)
    expect(stderr).toMatch(/architecture mismatch/)
  })
})

describe('the packager delegates to it', () => {
  const sh = readFileSync(join(REPO, 'scripts', 'package-app.sh'), 'utf8')

  it('package-app.sh calls the script instead of writing setup-info.json inline', () => {
    expect(sh).toContain('write-setup-info.mjs')
    // the old inline `node -e` heredoc wrote the file itself; exactly one writer now
    expect(sh).not.toContain("writeFileSync('$STAGE/setup-info.json'")
  })

  it('disables packager junk filtering so manifested payload files are not silently dropped', () => {
    expect(sh).toContain('--no-junk')
  })

  it('enables macOS alert-style notification actions before signing the app', () => {
    const alertStyle = sh.indexOf('NSUserNotificationAlertStyle')
    const signing = sh.indexOf('codesign --force --deep --sign -')
    expect(alertStyle).toBeGreaterThan(-1)
    expect(signing).toBeGreaterThan(alertStyle)
  })

  it('stamps the STAGED copy, from the repo root it also bakes as repoRoot', () => {
    expect(sh).toMatch(/write-setup-info\.mjs" "\$ROOT" "\$STAGE\/setup-info\.json"/)
  })
})
