// test/runtime-payload.test.ts — issue #74 Layer 1: the portable runtime
// payload primitives.
//
// Everything here drives the real CLIs as real child processes over real
// temp directories (mirroring test/package-stamp.test.ts's approach) rather
// than importing the .mjs modules directly: a .ts test file cannot statically
// or dynamically import a plain .mjs module without type declarations under
// this repo's strict, allowJs-less tsconfig, and exercising the CLI contract
// is exactly what a Bash caller (a future installer/packaging step) will do
// anyway.
import { describe, expect, it } from 'vitest'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO = resolve(import.meta.dirname, '..')
const PAYLOAD_CLI = join(REPO, 'scripts', 'runtime-payload.mjs')
const CONFIG_CLI = join(REPO, 'scripts', 'runtime-config.mjs')
const STAGE_CLI = join(REPO, 'scripts', 'stage-runtime.mjs')
const FAKE_NODE_FIXTURE = join(REPO, 'test', 'fixtures', 'runtime', 'fake-node.sh')
const FAKE_XATTR_FAIL_FIXTURE = join(REPO, 'test', 'fixtures', 'runtime', 'fake-xattr-fail.sh')
const FAKE_XATTR_RECORD_FIXTURE = join(REPO, 'test', 'fixtures', 'runtime', 'fake-xattr-record.sh')

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

interface CliResult {
  status: number
  stdout: string
  stderr: string
}

function runCli(script: string, args: string[], env?: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: env ?? process.env,
  })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

function runOk(script: string, args: string[], env?: NodeJS.ProcessEnv): unknown {
  const result = runCli(script, args, env)
  expect(result.stderr, `expected success, stderr was: ${result.stderr}`).toBe('')
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout)
}

function runFail(script: string, args: string[], env?: NodeJS.ProcessEnv): CliResult {
  const result = runCli(script, args, env)
  expect(result.status, 'expected a non-zero exit').not.toBe(0)
  return result
}

// Copies `scriptPaths` into a fresh real directory, then places a *separate*
// symlink alias directory pointing at it, and returns the scripts' paths as
// reached through that alias. This reproduces the real-world failure mode
// (confirmed present before the isMainModule() fix, and the reason
// test/install-runtime.test.ts's packaged-hooks test was failing): Node's
// ESM loader resolves `import.meta.url` for the entry module to its fully
// canonical (symlink-free) path, while `process.argv[1]` is left exactly as
// invoked — so any caller that reaches a script through a symlinked
// ancestor directory (an installed runtime under macOS's /var, itself a
// symlink to /private/var; a packaged app's Contents/Resources alias; a
// bin/ wrapper symlink) would previously make `fileURLToPath(import.meta
// .url) === resolve(process.argv[1])` false, so `main()` never ran and the
// process exited 0 having silently done nothing.
function createSymlinkedAlias(scriptPaths: string[]): string[] {
  const realDir = tmp('sym-real-')
  for (const p of scriptPaths) copyFileSync(p, join(realDir, basename(p)))
  const parentDir = tmp('sym-alias-parent-')
  const aliasDir = join(parentDir, 'alias')
  symlinkSync(realDir, aliasDir)
  return scriptPaths.map((p) => join(aliasDir, basename(p)))
}

// ── payload fixture builder ────────────────────────────────────────────
// A tiny, realistic-enough tree: a couple of "dist" entrypoints plus a
// nested file, so manifest/verify have more than one path to sort and walk.
function buildFixturePayload(root: string): void {
  mkdirSync(join(root, 'dist'), { recursive: true })
  mkdirSync(join(root, 'lib', 'nested'), { recursive: true })
  writeFileSync(join(root, 'dist', 'mcp-server.js'), 'console.log("mcp")\n')
  writeFileSync(join(root, 'dist', 'hook-cli.js'), 'console.log("hook")\n')
  writeFileSync(join(root, 'lib', 'nested', 'util.js'), 'module.exports = {}\n')
  chmodSync(join(root, 'dist', 'mcp-server.js'), 0o644)
  chmodSync(join(root, 'dist', 'hook-cli.js'), 0o644)
  chmodSync(join(root, 'lib', 'nested', 'util.js'), 0o644)
}

const DEFAULT_MANIFEST_OPTS = {
  product: 'test-runtime',
  packageVersion: '1.0.0',
  sourceCommit: 'deadbeefcafe',
  platform: 'darwin',
  arch: 'arm64',
  nodeVersion: 'v24.18.0',
  nodeModulesAbi: '137',
  entrypoints: ['dist/mcp-server.js', 'dist/hook-cli.js'],
}

function manifestArgs(root: string, overrides: Partial<typeof DEFAULT_MANIFEST_OPTS> = {}): string[] {
  const o = { ...DEFAULT_MANIFEST_OPTS, ...overrides }
  const args = [
    'manifest', '--root', root,
    '--product', o.product,
    '--package-version', o.packageVersion,
    '--source-commit', o.sourceCommit,
    '--platform', o.platform,
    '--arch', o.arch,
    '--node-version', o.nodeVersion,
    '--node-modules-abi', o.nodeModulesAbi,
  ]
  for (const entry of o.entrypoints) args.push('--entrypoint', entry)
  return args
}

function buildAndWriteManifest(root: string, overrides: Partial<typeof DEFAULT_MANIFEST_OPTS> = {}): Record<string, unknown> {
  return runOk(PAYLOAD_CLI, manifestArgs(root, overrides)) as Record<string, unknown>
}

// ── forged-manifest test helpers ───────────────────────────────────────
// Independent re-implementations of scripts/runtime-payload.mjs's
// sha256File/computePayloadDigest/computeRuntimeId, so a test can construct
// a manifest object that is FULLY self-consistent (its own digest and
// runtimeId genuinely match its own file list) around a malicious
// product/packageVersion/platform/arch value — the exact shape of manifest
// an attacker who fully controls the JSON, but not the verifier, could hand
// -craft. A .ts test file cannot import the .mjs module under this repo's
// tsconfig (see the file-header comment), so this must be reproduced
// locally rather than imported; any drift between the two would make these
// tests either vacuous (never actually self-consistent) or wrong (rejecting
// for the wrong reason), so keep this in lockstep with the real algorithm.
function sha256FileForTest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

interface ForgedFileRecord { path: string; size: number; mode: number; sha256: string }

function computeExpectedDigest(opts: {
  product: string
  packageVersion: string
  sourceCommit?: string | null
  platform: string
  arch: string
  nodeVersion: string
  nodeModulesAbi: string
  entrypoints: string[]
  files: ForgedFileRecord[]
}): string {
  const hash = createHash('sha256')
  const meta = JSON.stringify({
    product: opts.product,
    packageVersion: opts.packageVersion,
    sourceCommit: opts.sourceCommit ?? null,
    platform: opts.platform,
    arch: opts.arch,
    nodeVersion: opts.nodeVersion,
    nodeModulesAbi: opts.nodeModulesAbi,
    entrypoints: [...opts.entrypoints].sort(),
  })
  hash.update(meta)
  hash.update('\n')
  for (const file of opts.files) {
    hash.update(`${file.path}\u0000${file.size}\u0000${file.mode.toString(8)}\u0000${file.sha256}\n`)
  }
  return hash.digest('hex')
}

function computeExpectedRuntimeId(opts: {
  product: string
  packageVersion: string
  platform: string
  arch: string
  payloadDigest: string
}): string {
  return `${opts.product}-${opts.packageVersion}-${opts.platform}-${opts.arch}-${opts.payloadDigest.slice(0, 16)}`
}

// Hand-computes a fully self-consistent manifest object for `root` (a
// fixture built by buildFixturePayload) around a chosen (possibly
// malicious) set of identity fields, entirely bypassing buildManifest()
// and its now-added assertSafePathComponent() checks — the same way a
// hand-edited or hand-authored manifest.json would.
function forgeManifest(root: string, overrides: Partial<typeof DEFAULT_MANIFEST_OPTS> = {}): Record<string, unknown> {
  const o = { ...DEFAULT_MANIFEST_OPTS, ...overrides }
  const relPaths = ['dist/hook-cli.js', 'dist/mcp-server.js', 'lib/nested/util.js']
  const files: ForgedFileRecord[] = relPaths.map((relPath) => {
    const absPath = join(root, relPath)
    const stat = statSync(absPath)
    return { path: relPath, size: stat.size, mode: stat.mode & 0o777, sha256: sha256FileForTest(absPath) }
  })
  const payloadDigest = computeExpectedDigest({ ...o, files })
  const runtimeId = computeExpectedRuntimeId({ ...o, payloadDigest })
  return {
    schema: 1,
    product: o.product,
    packageVersion: o.packageVersion,
    sourceCommit: o.sourceCommit,
    platform: o.platform,
    arch: o.arch,
    nodeVersion: o.nodeVersion,
    nodeModulesAbi: o.nodeModulesAbi,
    entrypoints: [...o.entrypoints].sort(),
    files,
    payloadDigest,
    runtimeId,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// runtime-payload.mjs — manifest generation
// ═══════════════════════════════════════════════════════════════════════
describe('runtime-payload manifest: deterministic and structural', () => {
  it('produces byte-identical manifests (files sorted, digest stable) across two independent builds of the same tree', () => {
    const rootA = tmp('payload-a-')
    const rootB = tmp('payload-b-')
    buildFixturePayload(rootA)
    buildFixturePayload(rootB)

    const manifestA = buildAndWriteManifest(rootA)
    const manifestB = buildAndWriteManifest(rootB)

    expect(manifestA.payloadDigest).toBe(manifestB.payloadDigest)
    expect(manifestA.runtimeId).toBe(manifestB.runtimeId)
    const filesA = manifestA.files as Array<{ path: string }>
    const paths = filesA.map((f) => f.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths).toEqual(['dist/hook-cli.js', 'dist/mcp-server.js', 'lib/nested/util.js'])
  })

  it('changes the digest when file bytes change', () => {
    const root = tmp('payload-change-')
    buildFixturePayload(root)
    const before = buildAndWriteManifest(root)

    writeFileSync(join(root, 'dist', 'mcp-server.js'), 'console.log("mcp v2")\n')
    rmSync(join(root, 'runtime-manifest.json'))
    const after = buildAndWriteManifest(root)

    expect(after.payloadDigest).not.toBe(before.payloadDigest)
    expect(after.runtimeId).not.toBe(before.runtimeId)
  })

  it('rejects a payload with a symlink anywhere in the tree', () => {
    const root = tmp('payload-symlink-build-')
    buildFixturePayload(root)
    symlinkSync(join(root, 'dist', 'mcp-server.js'), join(root, 'dist', 'linked.js'))

    const result = runFail(PAYLOAD_CLI, manifestArgs(root))
    expect(result.stderr).toMatch(/symlink not allowed/)
  })

  it('refuses to build a manifest whose declared entrypoint is not in the payload', () => {
    const root = tmp('payload-missing-entry-')
    buildFixturePayload(root)

    const result = runFail(PAYLOAD_CLI, manifestArgs(root, { entrypoints: ['dist/does-not-exist.js'] }))
    expect(result.stderr).toMatch(/entrypoint not found/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// runtime-payload.mjs — verify: tamper / mode / symlink / traversal rejection
// ═══════════════════════════════════════════════════════════════════════
describe('runtime-payload verify: rejects every form of divergence from the manifest', () => {
  function freshVerifiedPayload(prefix: string): string {
    const root = tmp(prefix)
    buildFixturePayload(root)
    buildAndWriteManifest(root)
    return root
  }

  it('accepts an untouched, freshly manifested payload', () => {
    const root = freshVerifiedPayload('verify-ok-')
    const manifest = runOk(PAYLOAD_CLI, ['verify', '--root', root]) as Record<string, unknown>
    expect(manifest.runtimeId).toBeTypeOf('string')
  })

  it('rejects content tampering (checksum mismatch, same byte length)', () => {
    const root = freshVerifiedPayload('verify-tamper-')
    // Same length as the original ('console.log("mcp")\n') so this exercises
    // the checksum check specifically, distinct from the size-mismatch test below.
    writeFileSync(join(root, 'dist', 'mcp-server.js'), 'console.log("evl")\n')
    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    expect(result.stderr).toMatch(/checksum mismatch/)
  })

  it('rejects a size change even if undetected by a naive hash-only check path', () => {
    const root = freshVerifiedPayload('verify-size-')
    writeFileSync(join(root, 'dist', 'mcp-server.js'), 'console.log("mcp")\nconsole.log("extra")\n')
    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    expect(result.stderr).toMatch(/checksum mismatch|size mismatch/)
  })

  it('rejects a mode change on a manifested file', () => {
    const root = freshVerifiedPayload('verify-mode-')
    chmodSync(join(root, 'dist', 'mcp-server.js'), 0o755)
    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    expect(result.stderr).toMatch(/mode mismatch/)
  })

  it('rejects a symlink substituted for a manifested file', () => {
    const root = freshVerifiedPayload('verify-symlink-file-')
    const real = join(root, 'dist', 'real-target.js')
    writeFileSync(real, 'console.log("real")\n')
    rmSync(join(root, 'dist', 'mcp-server.js'))
    symlinkSync(real, join(root, 'dist', 'mcp-server.js'))
    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    expect(result.stderr).toMatch(/symlink not allowed/)
  })

  it('rejects an extra, unmanifested file added to the payload after manifesting', () => {
    const root = freshVerifiedPayload('verify-extra-')
    writeFileSync(join(root, 'dist', 'sneaky.js'), 'console.log("sneaky")\n')
    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    expect(result.stderr).toMatch(/unmanifested file present/)
  })

  it('rejects a manifested file that has gone missing', () => {
    const root = freshVerifiedPayload('verify-missing-')
    rmSync(join(root, 'lib', 'nested', 'util.js'))
    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    expect(result.stderr).toMatch(/manifested file missing/)
  })

  it('rejects a hand-edited manifest containing an absolute or traversal path', () => {
    const root = freshVerifiedPayload('verify-traversal-')
    const manifestPath = join(root, 'runtime-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.files.push({ path: '../escaped.js', size: 1, mode: 420, sha256: '0'.repeat(64) })
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    expect(result.stderr).toMatch(/unsafe payload path|traversal/)
  })

  it('rejects a hand-edited manifest with an absolute path', () => {
    const root = freshVerifiedPayload('verify-absolute-')
    const manifestPath = join(root, 'runtime-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.files.push({ path: '/etc/passwd', size: 1, mode: 420, sha256: '0'.repeat(64) })
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    expect(result.stderr).toMatch(/unsafe payload path/)
  })

  it('rejects a hand-edited manifest with a duplicate path', () => {
    const root = freshVerifiedPayload('verify-dup-')
    const manifestPath = join(root, 'runtime-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.files.push({ ...manifest.files[0] })
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    expect(result.stderr).toMatch(/duplicate path/)
  })

  it('rejects a manifest whose entrypoint was removed from the file list', () => {
    const root = freshVerifiedPayload('verify-no-entry-')
    const manifestPath = join(root, 'runtime-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.entrypoints.push('dist/never-shipped.js')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    expect(result.stderr).toMatch(/entrypoint missing/)
  })

  it('rejects a manifest whose recorded digest no longer matches its own file list (tampered manifest metadata)', () => {
    const root = freshVerifiedPayload('verify-digest-')
    const manifestPath = join(root, 'runtime-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.files[0].size = manifest.files[0].size + 1
    manifest.files[0].sha256 = manifest.files[0].sha256.replace(/^./, manifest.files[0].sha256[0] === '0' ? '1' : '0')
    // Keep the on-disk file itself untouched so the ONLY divergence is
    // between the manifest's own digest and its own (now-edited) records.
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    // Either the direct file-record check or the digest recomputation catches this.
    expect(result.stderr).toMatch(/mismatch/)
  })

  it('rejects when the payload does not match an expected platform/arch/version', () => {
    const root = freshVerifiedPayload('verify-expect-')
    const wrongArch = runFail(PAYLOAD_CLI, ['verify', '--root', root, '--arch', 'x64'])
    expect(wrongArch.stderr).toMatch(/manifest\.arch mismatch/)

    const wrongPlatform = runFail(PAYLOAD_CLI, ['verify', '--root', root, '--platform', 'linux'])
    expect(wrongPlatform.stderr).toMatch(/manifest\.platform mismatch/)

    const wrongVersion = runFail(PAYLOAD_CLI, ['verify', '--root', root, '--node-version', 'v20.0.0'])
    expect(wrongVersion.stderr).toMatch(/manifest\.nodeVersion mismatch/)

    const ok = runOk(PAYLOAD_CLI, ['verify', '--root', root, '--platform', 'darwin', '--arch', 'arm64', '--node-version', 'v24.18.0'])
    expect(ok).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// runtime-payload.mjs — install: atomic, idempotent, collision-safe
// ═══════════════════════════════════════════════════════════════════════
describe('runtime-payload install: atomic install, idempotency, and collision refusal', () => {
  it('installs a verified payload into runtimeRoot/<runtimeId>, verifiable afterward', () => {
    const payloadRoot = tmp('install-payload-')
    buildFixturePayload(payloadRoot)
    const manifest = buildAndWriteManifest(payloadRoot)
    const runtimeRoot = tmp('install-root-')

    const result = runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot]) as {
      installed: boolean
      runtimeId: string
      path: string
    }

    expect(result.installed).toBe(true)
    expect(result.runtimeId).toBe(manifest.runtimeId)
    expect(existsSync(join(result.path, 'dist', 'mcp-server.js'))).toBe(true)
    expect(existsSync(join(result.path, 'runtime-manifest.json'))).toBe(true)
    // The installed copy re-verifies cleanly on its own.
    runOk(PAYLOAD_CLI, ['verify', '--root', result.path])
  })

  it('never leaves a partial install visible: no leftover .tmp-install-* directories after a successful install', () => {
    const payloadRoot = tmp('install-clean-payload-')
    buildFixturePayload(payloadRoot)
    buildAndWriteManifest(payloadRoot)
    const runtimeRoot = tmp('install-clean-root-')

    runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot])

    const entries = readdirSync(runtimeRoot)
    expect(entries.some((e) => e.startsWith('.tmp-install-'))).toBe(false)
  })

  it('is idempotent: installing the exact same payload twice is a no-op the second time', () => {
    const payloadRoot = tmp('install-idem-payload-')
    buildFixturePayload(payloadRoot)
    buildAndWriteManifest(payloadRoot)
    const runtimeRoot = tmp('install-idem-root-')

    const first = runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot]) as { installed: boolean }
    const second = runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot]) as { installed: boolean }

    expect(first.installed).toBe(true)
    expect(second.installed).toBe(false)
  })

  it('refuses a corrupt collision: an existing runtimeId directory with different content is never overwritten', () => {
    const payloadRoot = tmp('install-collide-payload-')
    buildFixturePayload(payloadRoot)
    const manifest = buildAndWriteManifest(payloadRoot)
    const runtimeRoot = tmp('install-collide-root-')

    // Pre-create the destination directory by hand, under the same runtimeId,
    // but with content that does NOT match the manifest (a corrupt/foreign
    // occupant of that name).
    const destDir = join(runtimeRoot, manifest.runtimeId as string)
    mkdirSync(join(destDir, 'dist'), { recursive: true })
    writeFileSync(join(destDir, 'dist', 'mcp-server.js'), 'not the real payload\n')

    const result = runFail(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot])
    expect(result.stderr).toMatch(/collision/)
    // The corrupt occupant must be left exactly as it was — never touched.
    expect(readFileSync(join(destDir, 'dist', 'mcp-server.js'), 'utf8')).toBe('not the real payload\n')
  })

  it('refuses to install over an existing symlink at the destination name', () => {
    const payloadRoot = tmp('install-symlink-dest-payload-')
    buildFixturePayload(payloadRoot)
    const manifest = buildAndWriteManifest(payloadRoot)
    const runtimeRoot = tmp('install-symlink-dest-root-')
    mkdirSync(runtimeRoot, { recursive: true })
    const elsewhere = tmp('install-symlink-elsewhere-')
    symlinkSync(elsewhere, join(runtimeRoot, manifest.runtimeId as string))

    const result = runFail(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot])
    expect(result.stderr).toMatch(/symlink/)
  })

  it('enforces expected platform/arch at install time too', () => {
    const payloadRoot = tmp('install-expect-payload-')
    buildFixturePayload(payloadRoot)
    buildAndWriteManifest(payloadRoot)
    const runtimeRoot = tmp('install-expect-root-')

    const result = runFail(PAYLOAD_CLI, [
      'install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot, '--arch', 'x64',
    ])
    expect(result.stderr).toMatch(/manifest\.arch mismatch/)
  })

  // ── Darwin com.apple.quarantine clearing ──────────────────────────────
  // Node's copyFileSync does NOT propagate com.apple.quarantine to its
  // destination (verified empirically), so a real end-to-end assertion on
  // the attribute itself would pass vacuously whether or not the clearing
  // code ran at all. AGENT_INBOX_XATTR_BIN swaps in a fixture in place of
  // the fixed /usr/bin/xattr so the invocation itself — and its failure
  // handling — can be tested deterministically. Production code never sets
  // this variable; it always resolves the real fixed system path.
  it.runIf(process.platform === 'darwin')(
    'invokes the (overridden) xattr binary against the temp install directory before publishing',
    () => {
      const payloadRoot = tmp('install-xattr-payload-')
      buildFixturePayload(payloadRoot)
      buildAndWriteManifest(payloadRoot)
      const runtimeRoot = tmp('install-xattr-root-')
      const logDir = tmp('install-xattr-log-')
      const logFile = join(logDir, 'xattr-invocations.log')

      const result = runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot], {
        ...process.env,
        AGENT_INBOX_XATTR_BIN: FAKE_XATTR_RECORD_FIXTURE,
        FAKE_XATTR_LOG: logFile,
      }) as { installed: boolean; path: string }

      expect(result.installed).toBe(true)
      const invocations = readFileSync(logFile, 'utf8').trim().split('\n')
      expect(invocations).toHaveLength(1)
      // -rd com.apple.quarantine <temp install dir> — recorded BEFORE the
      // atomic rename that publishes it under result.path, so the logged
      // directory is the .tmp-install-* precursor, not the final name.
      expect(invocations[0]).toMatch(/^-rd com\.apple\.quarantine .*\.tmp-install-/)
      expect(invocations[0]).toContain(runtimeRoot)
    },
  )

  it.runIf(process.platform === 'darwin')(
    'refuses to publish when clearing com.apple.quarantine fails: nothing is installed',
    () => {
      const payloadRoot = tmp('install-xattr-fail-payload-')
      buildFixturePayload(payloadRoot)
      const manifest = buildAndWriteManifest(payloadRoot)
      const runtimeRoot = tmp('install-xattr-fail-root-')

      const result = runFail(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot], {
        ...process.env,
        AGENT_INBOX_XATTR_BIN: FAKE_XATTR_FAIL_FIXTURE,
      },
      )
      expect(result.stderr).toMatch(/failed to clear com\.apple\.quarantine/)
      expect(existsSync(join(runtimeRoot, manifest.runtimeId as string))).toBe(false)
      // No leftover temp directory either — the failed copy must be cleaned up.
      const entries = existsSync(runtimeRoot) ? readdirSync(runtimeRoot) : []
      expect(entries.some((e) => e.startsWith('.tmp-install-'))).toBe(false)
  })

  it('skips quarantine clearing cleanly when the (overridden) xattr binary does not exist', () => {
    const payloadRoot = tmp('install-xattr-absent-payload-')
    buildFixturePayload(payloadRoot)
    buildAndWriteManifest(payloadRoot)
    const runtimeRoot = tmp('install-xattr-absent-root-')

    const result = runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot], {
      ...process.env,
      AGENT_INBOX_XATTR_BIN: join(runtimeRoot, 'no-such-xattr-binary'),
    }) as { installed: boolean }
    expect(result.installed).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// runtime-payload.mjs — prune: exact, non-symlink, ownership-verified only
// ═══════════════════════════════════════════════════════════════════════
describe('runtime-payload prune: deletes only an exact, validly-owned runtime directory', () => {
  function installedFixture(prefix: string): { runtimeRoot: string; runtimeId: string } {
    const payloadRoot = tmp(`${prefix}-payload-`)
    buildFixturePayload(payloadRoot)
    const manifest = buildAndWriteManifest(payloadRoot)
    const runtimeRoot = tmp(`${prefix}-root-`)
    runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot])
    return { runtimeRoot, runtimeId: manifest.runtimeId as string }
  }

  it('deletes a valid, installed runtime directory', () => {
    const { runtimeRoot, runtimeId } = installedFixture('prune-ok')
    const result = runOk(PAYLOAD_CLI, ['prune', '--runtime-root', runtimeRoot, '--runtime-id', runtimeId]) as { pruned: boolean }
    expect(result.pruned).toBe(true)
    expect(existsSync(join(runtimeRoot, runtimeId))).toBe(false)
  })

  it('refuses to prune a runtimeId that does not exist', () => {
    const { runtimeRoot } = installedFixture('prune-missing')
    const result = runFail(PAYLOAD_CLI, ['prune', '--runtime-root', runtimeRoot, '--runtime-id', 'nope-1.0.0-darwin-arm64-0000'])
    expect(result.stderr).toMatch(/no such runtime/)
  })

  it('refuses to prune a symlinked child, even if it points at a valid runtime elsewhere', () => {
    const { runtimeRoot, runtimeId } = installedFixture('prune-symlink-a')
    const other = installedFixture('prune-symlink-b')
    const aliasId = 'alias-of-other'
    symlinkSync(join(other.runtimeRoot, other.runtimeId), join(runtimeRoot, aliasId))

    const result = runFail(PAYLOAD_CLI, ['prune', '--runtime-root', runtimeRoot, '--runtime-id', aliasId])
    expect(result.stderr).toMatch(/refusing to prune a symlink/)
    expect(existsSync(join(other.runtimeRoot, other.runtimeId))).toBe(true)

    // sanity: the original, non-aliased runtime is untouched
    expect(existsSync(join(runtimeRoot, runtimeId))).toBe(true)
  })

  it('refuses to prune a directory with no valid ownership manifest, even with a plausible-looking name', () => {
    const runtimeRoot = tmp('prune-unowned-root-')
    const fakeId = 'test-runtime-1.0.0-darwin-arm64-notreal00000000'
    mkdirSync(join(runtimeRoot, fakeId), { recursive: true })
    writeFileSync(join(runtimeRoot, fakeId, 'hello.txt'), 'just some directory, not a runtime\n')

    const result = runFail(PAYLOAD_CLI, ['prune', '--runtime-root', runtimeRoot, '--runtime-id', fakeId])
    expect(result.stderr).toMatch(/no manifest/)
    expect(existsSync(join(runtimeRoot, fakeId))).toBe(true)
  })

  it('rejects an unsafe runtimeId that tries to traverse outside runtimeRoot', () => {
    const { runtimeRoot } = installedFixture('prune-traversal')
    const result = runFail(PAYLOAD_CLI, ['prune', '--runtime-root', runtimeRoot, '--runtime-id', '../escape'])
    expect(result.stderr).toMatch(/unsafe runtimeId/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// runtime-payload.mjs — hardening: runtimeId path-escape rejection, and the
// manifest-file-itself-a-symlink bypass. Both are defense-in-depth on top
// of (not replacements for) the pre-existing checks: the digest/runtimeId
// self-consistency check in verifyPayload, and walkFiles()'s symlink
// rejection for ordinary payload files. Neither of those catches a manifest
// that is fully attacker-controlled (self-consistent around a malicious
// identity field) or a manifest FILE that is itself a symlink (walkFiles
// skips the manifest filename entirely, by design, so it never inspects
// the manifest entry's own symlink-ness).
// ═══════════════════════════════════════════════════════════════════════
describe('runtime-payload hardening: runtimeId path-escape and manifest-symlink rejection', () => {
  it('sanity: forgeManifest() reproduces buildAndWriteManifest()\'s real digest/runtimeId exactly for the same inputs', () => {
    const root = tmp('forge-sanity-')
    buildFixturePayload(root)
    const real = buildAndWriteManifest(root)
    rmSync(join(root, 'runtime-manifest.json'))
    const forged = forgeManifest(root)
    expect(forged.payloadDigest).toBe(real.payloadDigest)
    expect(forged.runtimeId).toBe(real.runtimeId)
  })

  // ── malicious identity fields rejected at manifest BUILD time ─────────
  for (const field of ['product', 'packageVersion', 'platform', 'arch'] as const) {
    it(`refuses to build a manifest with a path-traversal ${field}`, () => {
      const root = tmp(`build-unsafe-${field}-`)
      buildFixturePayload(root)
      const result = runFail(PAYLOAD_CLI, manifestArgs(root, { [field]: '../../../../tmp/evil-marker' }))
      expect(result.stderr).toMatch(new RegExp(`unsafe ${field}`))
      expect(existsSync(join(root, 'runtime-manifest.json'))).toBe(false)
    })

    it(`refuses to build a manifest with a ${field} containing a path separator`, () => {
      const root = tmp(`build-slash-${field}-`)
      buildFixturePayload(root)
      const result = runFail(PAYLOAD_CLI, manifestArgs(root, { [field]: 'evil/segment' }))
      expect(result.stderr).toMatch(new RegExp(`unsafe ${field}`))
    })
  }

  it('refuses a hand-edited manifest whose runtimeId field alone was overwritten with a traversal string', () => {
    const root = tmp('verify-hand-edited-runtimeid-')
    buildFixturePayload(root)
    buildAndWriteManifest(root)
    const manifestPath = join(root, 'runtime-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.runtimeId = '../../../../tmp/escaped-runtime-id'
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    expect(result.stderr).toMatch(/unsafe manifest\.runtimeId|mismatch/)
  })

  it('refuses a fully self-consistent forged manifest (product containing traversal, digest/runtimeId recomputed to match) at verify time', () => {
    const root = tmp('verify-forged-product-')
    buildFixturePayload(root)
    const escapeMarker = 'forged-escape-marker'
    const forged = forgeManifest(root, { product: `../../../../tmp/${escapeMarker}` })
    writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify(forged, null, 2))

    // Prove the forgery really is self-consistent (i.e. this is not merely
    // re-testing the pre-existing digest/runtimeId mismatch check): a
    // verify performed with only the OLD (pre-hardening) checks — schema,
    // file records, on-disk match, digest/runtimeId self-consistency —
    // would have accepted this manifest.
    expect((forged.product as string)).toContain(escapeMarker)

    const result = runFail(PAYLOAD_CLI, ['verify', '--root', root])
    expect(result.stderr).toMatch(/unsafe manifest\.product/)
  })

  it('refuses to install a fully self-consistent forged manifest, and creates nothing outside runtimeRoot', () => {
    const payloadRoot = tmp('install-forged-payload-')
    buildFixturePayload(payloadRoot)
    const runtimeRoot = tmp('install-forged-root-')
    // Unique per test run (via a fresh mkdtemp basename) so a prior run
    // that actually exercised the vulnerability (i.e. before this fix
    // existed) can never leave a stale directory on disk that this
    // assertion would trip over on a later, correctly-fixed run.
    const escapeMarker = basename(tmp('install-forged-escape-marker-'))
    // Craft `product` so that, were the OLD code path (`join(runtimeRoot,
    // runtimeId)` with no containment re-check) still in effect, the
    // resulting runtimeId's leading `../<marker>` segment would make
    // `join()` collapse straight OUT of runtimeRoot and into a directory
    // literally named after the marker, as a SIBLING of runtimeRoot rather
    // than a child of it.
    const forged = forgeManifest(payloadRoot, { product: `../${escapeMarker}` })
    writeFileSync(join(payloadRoot, 'runtime-manifest.json'), JSON.stringify(forged, null, 2))
    // Sanity: prove the forged runtimeId really does contain a traversal
    // segment AND that the naive join() really would land outside
    // runtimeRoot (i.e. this test would actually catch a regression, not
    // just trivially pass because the crafted path never lines up).
    expect(forged.runtimeId as string).toContain('/')
    const wouldBeEscapeTarget = resolve(join(runtimeRoot, forged.runtimeId as string))
    expect(wouldBeEscapeTarget.startsWith(resolve(runtimeRoot) + '/')).toBe(false)
    expect(dirname(wouldBeEscapeTarget)).toBe(dirname(resolve(runtimeRoot)))

    try {
      const result = runFail(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot])
      expect(result.stderr).toMatch(/unsafe manifest\.product/)
      expect(existsSync(wouldBeEscapeTarget)).toBe(false)
      // runtimeRoot itself must also come up empty — nothing was ever staged or published.
      expect(existsSync(runtimeRoot) ? readdirSync(runtimeRoot) : []).toEqual([])
    } finally {
      // Belt-and-braces: if a future regression ever DOES create this
      // directory, don't leave it behind to confuse later runs.
      rmSync(wouldBeEscapeTarget, { recursive: true, force: true })
    }
  })

  it('refuses an external identical-manifest symlink: a manifest entry that is itself a symlink to a byte-identical, otherwise-valid manifest elsewhere', () => {
    const rootA = tmp('symlink-manifest-a-')
    const rootB = tmp('symlink-manifest-b-')
    buildFixturePayload(rootA)
    buildFixturePayload(rootB)
    const manifestA = buildAndWriteManifest(rootA)
    const manifestB = buildAndWriteManifest(rootB)
    // Byte-identical payloads/manifests, proven the same way the
    // determinism test above proves it.
    expect(manifestB.payloadDigest).toBe(manifestA.payloadDigest)

    // Replace rootB's OWN manifest with a symlink to rootA's (equally
    // valid, byte-identical) manifest. Every field, digest, runtimeId and
    // on-disk file record matches perfectly — the only thing wrong is that
    // rootB's manifest entry is not a real file physically inside rootB.
    rmSync(join(rootB, 'runtime-manifest.json'))
    symlinkSync(join(rootA, 'runtime-manifest.json'), join(rootB, 'runtime-manifest.json'))

    const result = runFail(PAYLOAD_CLI, ['verify', '--root', rootB])
    expect(result.stderr).toMatch(/symlink/)
  })

  it('refuses install\'s idempotent-match short-circuit when the existing destination\'s manifest is itself a symlink to a valid, matching manifest elsewhere', () => {
    const payloadRoot = tmp('install-idem-symlink-payload-')
    buildFixturePayload(payloadRoot)
    const manifest = buildAndWriteManifest(payloadRoot)
    const runtimeRoot = tmp('install-idem-symlink-root-')

    // Hand-craft the destination directory as if a previous install had
    // completed, but with its manifest file replaced by a symlink to the
    // real payload's (byte-identical, fully valid) manifest — rather than
    // physically containing its own.
    const destDir = join(runtimeRoot, manifest.runtimeId as string)
    mkdirSync(join(destDir, 'dist'), { recursive: true })
    mkdirSync(join(destDir, 'lib', 'nested'), { recursive: true })
    copyFileSync(join(payloadRoot, 'dist', 'mcp-server.js'), join(destDir, 'dist', 'mcp-server.js'))
    copyFileSync(join(payloadRoot, 'dist', 'hook-cli.js'), join(destDir, 'dist', 'hook-cli.js'))
    copyFileSync(join(payloadRoot, 'lib', 'nested', 'util.js'), join(destDir, 'lib', 'nested', 'util.js'))
    symlinkSync(join(payloadRoot, 'runtime-manifest.json'), join(destDir, 'runtime-manifest.json'))

    const result = runFail(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot])
    expect(result.stderr).toMatch(/collision|symlink/)
  })
})

describe('runtime-payload list', () => {
  it('reports every installed runtime, and flags one with a tampered manifest as invalid rather than crashing', () => {
    const payloadRoot = tmp('list-payload-')
    buildFixturePayload(payloadRoot)
    const manifest = buildAndWriteManifest(payloadRoot)
    const runtimeRoot = tmp('list-root-')
    runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot])

    // A second, unrelated directory with no manifest at all.
    mkdirSync(join(runtimeRoot, 'not-a-runtime'), { recursive: true })

    const list = runOk(PAYLOAD_CLI, ['list', '--runtime-root', runtimeRoot]) as Array<{ runtimeId: string; valid: boolean }>
    const owned = list.find((entry) => entry.runtimeId === manifest.runtimeId)
    const foreign = list.find((entry) => entry.runtimeId === 'not-a-runtime')
    expect(owned?.valid).toBe(true)
    expect(foreign?.valid).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// runtime-config.mjs — canonical ownership/reference classification
// ═══════════════════════════════════════════════════════════════════════
describe('runtime-config classify: canonical ownership/reference logic', () => {
  function installedRuntime(): { runtimeRoot: string; runtimeDir: string; nodeBin: string; entry: string } {
    const payloadRoot = tmp('config-payload-')
    mkdirSync(join(payloadRoot, 'bin'), { recursive: true })
    mkdirSync(join(payloadRoot, 'dist'), { recursive: true })
    writeFileSync(join(payloadRoot, 'bin', 'node'), 'fake node binary\n')
    writeFileSync(join(payloadRoot, 'dist', 'mcp-server.js'), 'console.log("mcp")\n')
    chmodSync(join(payloadRoot, 'bin', 'node'), 0o755)
    chmodSync(join(payloadRoot, 'dist', 'mcp-server.js'), 0o644)
    const manifest = buildAndWriteManifest(payloadRoot, { entrypoints: ['dist/mcp-server.js'] })
    const runtimeRoot = tmp('config-root-')
    const install = runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot]) as { path: string }
    return {
      runtimeRoot,
      runtimeDir: install.path,
      nodeBin: join(install.path, 'bin', 'node'),
      entry: join(install.path, 'dist', 'mcp-server.js'),
    }
  }

  it('classifies matching node+entry under the runtime root as owned', () => {
    const { runtimeRoot, nodeBin, entry } = installedRuntime()
    const result = runOk(CONFIG_CLI, [
      'classify', '--node-bin', nodeBin, '--entry', entry, '--runtime-root', runtimeRoot,
    ]) as { status: string; runtimeId?: string }
    expect(result.status).toBe('owned')
    expect(result.runtimeId).toBeTypeOf('string')
  })

  it('resolves symlink and ".." aliases to the SAME canonical runtime directory and still classifies as owned', () => {
    const { runtimeRoot, nodeBin, entry, runtimeDir } = installedRuntime()
    const aliasDir = tmp('config-alias-')
    const nodeAlias = join(aliasDir, 'node-alias')
    symlinkSync(nodeBin, nodeAlias)
    // A ".."-laden but equivalent path to the entry file.
    const dotDotEntry = join(runtimeDir, 'dist', '..', 'dist', 'mcp-server.js')

    const result = runOk(CONFIG_CLI, [
      'classify', '--node-bin', nodeAlias, '--entry', dotDotEntry, '--runtime-root', runtimeRoot,
    ]) as { status: string }
    expect(result.status).toBe('owned')
    void entry
  })

  it('classifies paths entirely outside the runtime root as custom (a user\'s own Node setup)', () => {
    const { runtimeRoot } = installedRuntime()
    const custom = tmp('config-custom-')
    writeFileSync(join(custom, 'node'), 'custom node\n')
    writeFileSync(join(custom, 'entry.js'), 'custom entry\n')

    const result = runOk(CONFIG_CLI, [
      'classify', '--node-bin', join(custom, 'node'), '--entry', join(custom, 'entry.js'), '--runtime-root', runtimeRoot,
    ]) as { status: string }
    expect(result.status).toBe('custom')
  })

  it('classifies mismatched pairing (node managed, entry not) as split, never as owned', () => {
    const { runtimeRoot, nodeBin } = installedRuntime()
    const custom = tmp('config-split-')
    writeFileSync(join(custom, 'entry.js'), 'custom entry\n')

    const result = runOk(CONFIG_CLI, [
      'classify', '--node-bin', nodeBin, '--entry', join(custom, 'entry.js'), '--runtime-root', runtimeRoot,
    ]) as { status: string }
    expect(result.status).toBe('split')
  })

  it('classifies two DIFFERENT owned runtime directories (node from one, entry from another) as split', () => {
    const a = installedRuntime()
    const b = installedRuntime()

    const result = runOk(CONFIG_CLI, [
      'classify', '--node-bin', a.nodeBin, '--entry', b.entry, '--runtime-root', a.runtimeRoot,
    ]) as { status: string }
    // b's entry does not even resolve under a's runtime root, so this also
    // covers "split" via the not-under-root path when roots differ; here we
    // additionally check the same-root, different-runtimeId case:
    expect(['split', 'custom']).toContain(result.status)

    // Same-root, different-runtimeId split: install a second runtime under
    // the SAME runtimeRoot and mix node/entry across the two.
    const payloadRoot2 = tmp('config-split2-payload-')
    mkdirSync(join(payloadRoot2, 'bin'), { recursive: true })
    mkdirSync(join(payloadRoot2, 'dist'), { recursive: true })
    writeFileSync(join(payloadRoot2, 'bin', 'node'), 'a different fake node binary\n')
    writeFileSync(join(payloadRoot2, 'dist', 'mcp-server.js'), 'console.log("mcp2")\n')
    chmodSync(join(payloadRoot2, 'bin', 'node'), 0o755)
    chmodSync(join(payloadRoot2, 'dist', 'mcp-server.js'), 0o644)
    buildAndWriteManifest(payloadRoot2, { entrypoints: ['dist/mcp-server.js'] })
    const install2 = runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot2, '--runtime-root', a.runtimeRoot]) as { path: string }

    const sameRootResult = runOk(CONFIG_CLI, [
      'classify', '--node-bin', a.nodeBin, '--entry', join(install2.path, 'dist', 'mcp-server.js'), '--runtime-root', a.runtimeRoot,
    ]) as { status: string }
    expect(sameRootResult.status).toBe('split')
  })

  it('retains (returns unknown) when a path does not exist', () => {
    const { runtimeRoot, entry } = installedRuntime()
    const result = runOk(CONFIG_CLI, [
      'classify', '--node-bin', join(runtimeRoot, 'nope', 'node'), '--entry', entry, '--runtime-root', runtimeRoot,
    ]) as { status: string }
    expect(result.status).toBe('unknown')
  })

  it('retains (returns unknown) when the resolved runtime directory has an invalid/tampered manifest', () => {
    const { runtimeRoot, nodeBin, entry, runtimeDir } = installedRuntime()
    // Tamper with the installed runtime's manifest directly.
    writeFileSync(join(runtimeDir, 'runtime-manifest.json'), '{not valid json')

    const result = runOk(CONFIG_CLI, [
      'classify', '--node-bin', nodeBin, '--entry', entry, '--runtime-root', runtimeRoot,
    ]) as { status: string }
    expect(result.status).toBe('unknown')
  })

  it('never throws — classify always exits 0 with a status, even for nonsense inputs', () => {
    const runtimeRoot = tmp('config-nonsense-root-')
    const result = runOk(CONFIG_CLI, [
      'classify', '--node-bin', '/does/not/exist/node', '--entry', '/does/not/exist/entry.js', '--runtime-root', runtimeRoot,
    ]) as { status: string }
    expect(['unknown', 'custom']).toContain(result.status)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// runtime-config.mjs — references: prune/rollback safety gating
// ═══════════════════════════════════════════════════════════════════════
describe('runtime-config references: structural reference gate for prune/rollback', () => {
  function installedRuntime(): { runtimeRoot: string; runtimeId: string; nodeBin: string; entry: string } {
    const payloadRoot = tmp('refs-payload-')
    mkdirSync(join(payloadRoot, 'bin'), { recursive: true })
    mkdirSync(join(payloadRoot, 'dist'), { recursive: true })
    writeFileSync(join(payloadRoot, 'bin', 'node'), 'fake node binary\n')
    writeFileSync(join(payloadRoot, 'dist', 'mcp-server.js'), 'console.log("mcp")\n')
    chmodSync(join(payloadRoot, 'bin', 'node'), 0o755)
    chmodSync(join(payloadRoot, 'dist', 'mcp-server.js'), 0o644)
    const manifest = buildAndWriteManifest(payloadRoot, { entrypoints: ['dist/mcp-server.js'] })
    const runtimeRoot = tmp('refs-root-')
    const install = runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot]) as { path: string }
    return {
      runtimeRoot,
      runtimeId: manifest.runtimeId as string,
      nodeBin: join(install.path, 'bin', 'node'),
      entry: join(install.path, 'dist', 'mcp-server.js'),
    }
  }

  it('reports unreferenced when every given file is simply missing (missing files are okay)', () => {
    const { runtimeRoot, runtimeId } = installedRuntime()
    const result = runOk(CONFIG_CLI, [
      'references', '--runtime-root', runtimeRoot, '--runtime-id', runtimeId,
      '--file', join(runtimeRoot, 'no-such-settings.json'),
    ]) as { status: string; matches: unknown[] }
    expect(result.status).toBe('unreferenced')
    expect(result.matches).toHaveLength(0)
  })

  it('reports referenced when a file contains an owned {command,args} pair resolving to the exact runtimeId', () => {
    const { runtimeRoot, runtimeId, nodeBin, entry } = installedRuntime()
    const dir = tmp('refs-hit-')
    const settingsFile = join(dir, 'settings.json')
    // Nested arbitrarily deep, matching a real hook-settings shape, to prove
    // the walk is structural/recursive and not shape-specific.
    writeFileSync(settingsFile, JSON.stringify({
      hooks: { Notification: [{ hooks: [{ type: 'command', command: nodeBin, args: [entry, 'notification'] }] }] },
    }))

    const result = runOk(CONFIG_CLI, [
      'references', '--runtime-root', runtimeRoot, '--runtime-id', runtimeId, '--file', settingsFile,
    ]) as { status: string; matches: Array<{ file: string }> }
    expect(result.status).toBe('referenced')
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.file).toBe(settingsFile)
  })

  it('also matches an MCP-registration shape (mcpServers.<name>: {command, args})', () => {
    const { runtimeRoot, runtimeId, nodeBin, entry } = installedRuntime()
    const dir = tmp('refs-mcp-')
    const configFile = join(dir, 'mcp-config.json')
    writeFileSync(configFile, JSON.stringify({ mcpServers: { 'agent-inbox': { command: nodeBin, args: [entry] } } }))

    const result = runOk(CONFIG_CLI, [
      'references', '--runtime-root', runtimeRoot, '--runtime-id', runtimeId, '--file', configFile,
    ]) as { status: string }
    expect(result.status).toBe('referenced')
  })

  it('reports unreferenced when a file only contains pairs pointing at a DIFFERENT runtimeId', () => {
    const target = installedRuntime()
    const other = installedRuntime()
    const dir = tmp('refs-miss-')
    const settingsFile = join(dir, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify({ command: other.nodeBin, args: [other.entry] }))

    const result = runOk(CONFIG_CLI, [
      'references', '--runtime-root', target.runtimeRoot, '--runtime-id', target.runtimeId, '--file', settingsFile,
    ]) as { status: string; matches: unknown[] }
    expect(result.status).toBe('unreferenced')
    expect(result.matches).toHaveLength(0)
  })

  it('reports unreferenced (not unknown) when a file has only custom/split pairs — those do not count as a reference', () => {
    const { runtimeRoot, runtimeId } = installedRuntime()
    const dir = tmp('refs-custom-')
    const settingsFile = join(dir, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify({ command: '/usr/bin/node', args: ['/usr/local/bin/some-other-tool.js'] }))

    const result = runOk(CONFIG_CLI, [
      'references', '--runtime-root', runtimeRoot, '--runtime-id', runtimeId, '--file', settingsFile,
    ]) as { status: string }
    expect(result.status).toBe('unreferenced')
  })

  it('reports unknown when a file exists but is not valid JSON (retain: cannot rule out a reference)', () => {
    const { runtimeRoot, runtimeId } = installedRuntime()
    const dir = tmp('refs-badjson-')
    const settingsFile = join(dir, 'settings.json')
    writeFileSync(settingsFile, '{not valid json at all')

    const result = runOk(CONFIG_CLI, [
      'references', '--runtime-root', runtimeRoot, '--runtime-id', runtimeId, '--file', settingsFile,
    ]) as { status: string }
    expect(result.status).toBe('unknown')
  })

  it('reports unknown when a file exists but is unreadable (retain: cannot rule out a reference)', () => {
    const { runtimeRoot, runtimeId } = installedRuntime()
    const dir = tmp('refs-unreadable-')
    const settingsFile = join(dir, 'settings.json')
    writeFileSync(settingsFile, '{}')
    chmodSync(settingsFile, 0o000)

    try {
      const result = runOk(CONFIG_CLI, [
        'references', '--runtime-root', runtimeRoot, '--runtime-id', runtimeId, '--file', settingsFile,
      ]) as { status: string }
      expect(result.status).toBe('unknown')
    } finally {
      chmodSync(settingsFile, 0o644)
    }
  })

  it('referenced takes precedence over an unrelated unknown file among multiple --file entries', () => {
    const { runtimeRoot, runtimeId, nodeBin, entry } = installedRuntime()
    const dir = tmp('refs-mixed-')
    const goodFile = join(dir, 'good.json')
    const badFile = join(dir, 'bad.json')
    writeFileSync(goodFile, JSON.stringify({ command: nodeBin, args: [entry] }))
    writeFileSync(badFile, 'not json')

    const result = runOk(CONFIG_CLI, [
      'references', '--runtime-root', runtimeRoot, '--runtime-id', runtimeId,
      '--file', goodFile, '--file', badFile,
    ]) as { status: string }
    expect(result.status).toBe('referenced')
  })

  it('exits 2 when no --file is given at all', () => {
    const { runtimeRoot, runtimeId } = installedRuntime()
    const result = runFail(CONFIG_CLI, ['references', '--runtime-root', runtimeRoot, '--runtime-id', runtimeId])
    expect(result.status).toBe(2)
  })

  it('exits 2 when --runtime-root or --runtime-id is missing', () => {
    const dir = tmp('refs-usage-')
    const result = runFail(CONFIG_CLI, ['references', '--file', join(dir, 'x.json')])
    expect(result.status).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// runtime-config.mjs — registration: install/upgrade/uninstall safety gate
// ═══════════════════════════════════════════════════════════════════════
describe('runtime-config registration: MCP server registration ownership gate', () => {
  function installedRuntime(): { runtimeRoot: string; runtimeId: string; nodeBin: string; entry: string } {
    const payloadRoot = tmp('reg-payload-')
    mkdirSync(join(payloadRoot, 'bin'), { recursive: true })
    mkdirSync(join(payloadRoot, 'dist'), { recursive: true })
    writeFileSync(join(payloadRoot, 'bin', 'node'), 'fake node binary\n')
    writeFileSync(join(payloadRoot, 'dist', 'mcp-server.js'), 'console.log("mcp")\n')
    chmodSync(join(payloadRoot, 'bin', 'node'), 0o755)
    chmodSync(join(payloadRoot, 'dist', 'mcp-server.js'), 0o644)
    const manifest = buildAndWriteManifest(payloadRoot, { entrypoints: ['dist/mcp-server.js'] })
    const runtimeRoot = tmp('reg-root-')
    const install = runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot]) as { path: string }
    return {
      runtimeRoot,
      runtimeId: manifest.runtimeId as string,
      nodeBin: join(install.path, 'bin', 'node'),
      entry: join(install.path, 'dist', 'mcp-server.js'),
    }
  }

  it('reports absent when the registration file does not exist at all', () => {
    const { runtimeRoot } = installedRuntime()
    const result = runOk(CONFIG_CLI, [
      'registration', '--file', join(runtimeRoot, 'no-such-config.json'), '--runtime-root', runtimeRoot,
    ]) as { status: string }
    expect(result.status).toBe('absent')
  })

  it('reports absent when the file exists and is valid JSON but has no mcpServers.<server> entry', () => {
    const { runtimeRoot } = installedRuntime()
    const dir = tmp('reg-noserver-')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ mcpServers: { 'some-other-server': { command: '/bin/x', args: ['/bin/y'] } } }))

    const result = runOk(CONFIG_CLI, [
      'registration', '--file', configFile, '--runtime-root', runtimeRoot, '--server', 'agent-inbox',
    ]) as { status: string }
    expect(result.status).toBe('absent')
  })

  it('reports absent when the file has no mcpServers key at all', () => {
    const { runtimeRoot } = installedRuntime()
    const dir = tmp('reg-nomcp-')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ hooks: {} }))

    const result = runOk(CONFIG_CLI, ['registration', '--file', configFile, '--runtime-root', runtimeRoot]) as { status: string }
    expect(result.status).toBe('absent')
  })

  it('reports owned when the registration command+args[0] resolve to a valid runtime under runtimeRoot', () => {
    const { runtimeRoot, runtimeId, nodeBin, entry } = installedRuntime()
    const dir = tmp('reg-owned-')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({
      mcpServers: { 'agent-inbox': { command: nodeBin, args: [entry, '--stdio'] } },
    }))

    const result = runOk(CONFIG_CLI, [
      'registration', '--file', configFile, '--runtime-root', runtimeRoot, '--server', 'agent-inbox',
    ]) as { status: string; runtimeId?: string; node?: string; entry?: string; server?: string }
    expect(result.status).toBe('owned')
    expect(result.runtimeId).toBe(runtimeId)
    expect(result.node).toBe(nodeBin)
    expect(result.entry).toBe(entry)
    expect(result.server).toBe('agent-inbox')
  })

  it('defaults --server to "agent-inbox" when not given', () => {
    const { runtimeRoot, nodeBin, entry } = installedRuntime()
    const dir = tmp('reg-default-server-')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ mcpServers: { 'agent-inbox': { command: nodeBin, args: [entry] } } }))

    const result = runOk(CONFIG_CLI, ['registration', '--file', configFile, '--runtime-root', runtimeRoot]) as { status: string }
    expect(result.status).toBe('owned')
  })

  it('respects a custom --server name', () => {
    const { runtimeRoot, nodeBin, entry } = installedRuntime()
    const dir = tmp('reg-custom-server-')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ mcpServers: { 'my-agent-inbox': { command: nodeBin, args: [entry] } } }))

    const asDefault = runOk(CONFIG_CLI, ['registration', '--file', configFile, '--runtime-root', runtimeRoot]) as { status: string }
    expect(asDefault.status).toBe('absent')

    const asCustomName = runOk(CONFIG_CLI, [
      'registration', '--file', configFile, '--runtime-root', runtimeRoot, '--server', 'my-agent-inbox',
    ]) as { status: string }
    expect(asCustomName.status).toBe('owned')
  })

  it('reports custom when the registration points entirely outside the managed runtime root', () => {
    const { runtimeRoot } = installedRuntime()
    const custom = tmp('reg-custompath-')
    writeFileSync(join(custom, 'node'), 'custom node\n')
    writeFileSync(join(custom, 'entry.js'), 'custom entry\n')
    const dir = tmp('reg-custom-')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({
      mcpServers: { 'agent-inbox': { command: join(custom, 'node'), args: [join(custom, 'entry.js')] } },
    }))

    const result = runOk(CONFIG_CLI, ['registration', '--file', configFile, '--runtime-root', runtimeRoot]) as { status: string }
    expect(result.status).toBe('custom')
  })

  it('reports split when node and entry disagree (one managed, one not)', () => {
    const { runtimeRoot, nodeBin } = installedRuntime()
    const custom = tmp('reg-split-')
    writeFileSync(join(custom, 'entry.js'), 'custom entry\n')
    const dir = tmp('reg-split-config-')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({
      mcpServers: { 'agent-inbox': { command: nodeBin, args: [join(custom, 'entry.js')] } },
    }))

    const result = runOk(CONFIG_CLI, ['registration', '--file', configFile, '--runtime-root', runtimeRoot]) as { status: string }
    expect(result.status).toBe('split')
  })

  it('reports unknown when the file exists but is not valid JSON', () => {
    const { runtimeRoot } = installedRuntime()
    const dir = tmp('reg-badjson-')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, '{not valid json')

    const result = runOk(CONFIG_CLI, ['registration', '--file', configFile, '--runtime-root', runtimeRoot]) as { status: string }
    expect(result.status).toBe('unknown')
  })

  it('reports unknown when the file is unreadable', () => {
    const { runtimeRoot } = installedRuntime()
    const dir = tmp('reg-unreadable-')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, '{}')
    chmodSync(configFile, 0o000)

    try {
      const result = runOk(CONFIG_CLI, ['registration', '--file', configFile, '--runtime-root', runtimeRoot]) as { status: string }
      expect(result.status).toBe('unknown')
    } finally {
      chmodSync(configFile, 0o644)
    }
  })

  it('reports unknown when mcpServers.<server> exists but is not a well-formed {command, args} shape', () => {
    const { runtimeRoot } = installedRuntime()
    const dir = tmp('reg-malformed-')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ mcpServers: { 'agent-inbox': { command: '/bin/node' } } }))

    const result = runOk(CONFIG_CLI, ['registration', '--file', configFile, '--runtime-root', runtimeRoot]) as { status: string }
    expect(result.status).toBe('unknown')
  })

  it('reports unknown when mcpServers.<server> has empty args (no entry to resolve)', () => {
    const { runtimeRoot, nodeBin } = installedRuntime()
    const dir = tmp('reg-emptyargs-')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ mcpServers: { 'agent-inbox': { command: nodeBin, args: [] } } }))

    const result = runOk(CONFIG_CLI, ['registration', '--file', configFile, '--runtime-root', runtimeRoot]) as { status: string }
    expect(result.status).toBe('unknown')
  })

  it('exits 2 when --file is missing', () => {
    const { runtimeRoot } = installedRuntime()
    const result = runFail(CONFIG_CLI, ['registration', '--runtime-root', runtimeRoot])
    expect(result.status).toBe(2)
  })

  it('exits 2 when --runtime-root is missing', () => {
    const dir = tmp('reg-usage-')
    const result = runFail(CONFIG_CLI, ['registration', '--file', join(dir, 'x.json')])
    expect(result.status).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// runtime-config.mjs — atomic JSON mutation
// ═══════════════════════════════════════════════════════════════════════
describe('runtime-config merge-json: atomic hook-settings mutation', () => {
  it('creates a new file when none exists', () => {
    const dir = tmp('merge-new-')
    const file = join(dir, 'settings.json')
    const merged = runOk(CONFIG_CLI, ['merge-json', '--file', file, '--patch', JSON.stringify({ hooks: { a: 1 } })])
    expect(merged).toEqual({ hooks: { a: 1 } })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ hooks: { a: 1 } })
  })

  it('deep-merges into an existing file, preserving unrelated keys', () => {
    const dir = tmp('merge-existing-')
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ hooks: { a: 1 }, keepMe: 'yes' }))

    const merged = runOk(CONFIG_CLI, ['merge-json', '--file', file, '--patch', JSON.stringify({ hooks: { b: 2 } })])
    expect(merged).toEqual({ hooks: { a: 1, b: 2 }, keepMe: 'yes' })
  })

  it('replaces (does not merge) array and scalar values', () => {
    const dir = tmp('merge-replace-')
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ list: [1, 2, 3], name: 'old' }))

    const merged = runOk(CONFIG_CLI, ['merge-json', '--file', file, '--patch', JSON.stringify({ list: [9], name: 'new' })])
    expect(merged).toEqual({ list: [9], name: 'new' })
  })

  it('writes through a symlink to its real target, leaving the symlink itself in place', () => {
    const dir = tmp('merge-symlink-')
    const realFile = join(dir, 'real-settings.json')
    writeFileSync(realFile, JSON.stringify({ hooks: {} }))
    const linkFile = join(dir, 'settings.json')
    symlinkSync(realFile, linkFile)

    runOk(CONFIG_CLI, ['merge-json', '--file', linkFile, '--patch', JSON.stringify({ hooks: { added: true } })])

    expect(lstatSync(linkFile).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(realFile, 'utf8'))).toEqual({ hooks: { added: true } })
  })

  it('never leaves a stray .tmp file behind after a successful merge', () => {
    const dir = tmp('merge-clean-')
    const file = join(dir, 'settings.json')
    runOk(CONFIG_CLI, ['merge-json', '--file', file, '--patch', JSON.stringify({ a: 1 })])

    const entries = readdirSync(dir)
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// runtime-config.mjs — the `hooks` transformation (Claude Code settings.json)
// ═══════════════════════════════════════════════════════════════════════
describe('runtime-config hooks: packaged Claude Code hook-settings transformation', () => {
  function installedHookRuntime(overrides: Partial<typeof DEFAULT_MANIFEST_OPTS> = {}): {
    runtimeRoot: string
    nodeBin: string
    entry: string
  } {
    const payloadRoot = tmp('hooks-payload-')
    mkdirSync(join(payloadRoot, 'bin'), { recursive: true })
    mkdirSync(join(payloadRoot, 'dist'), { recursive: true })
    writeFileSync(join(payloadRoot, 'bin', 'node'), 'fake node binary\n')
    writeFileSync(join(payloadRoot, 'dist', 'hook-cli.js'), 'console.log("hook")\n')
    chmodSync(join(payloadRoot, 'bin', 'node'), 0o755)
    chmodSync(join(payloadRoot, 'dist', 'hook-cli.js'), 0o644)
    buildAndWriteManifest(payloadRoot, {
      product: 'agent-inbox-runtime',
      entrypoints: ['dist/hook-cli.js'],
      ...overrides,
    })
    const runtimeRoot = tmp('hooks-root-')
    const install = runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot, '--runtime-root', runtimeRoot]) as { path: string }
    return { runtimeRoot, nodeBin: join(install.path, 'bin', 'node'), entry: join(install.path, 'dist', 'hook-cli.js') }
  }

  interface HookEntry {
    type: string
    command: string
    args: string[]
    timeout: number
    [key: string]: unknown
  }
  interface HookGroup { matcher?: string; hooks: HookEntry[] }
  interface HooksSettings { hooks?: Record<string, HookGroup[]>; [key: string]: unknown }

  it('installs the full six-subcommand block into an empty/missing settings file', () => {
    const { runtimeRoot, nodeBin, entry } = installedHookRuntime()
    const settings = join(tmp('hooks-fresh-'), 'settings.json')

    const result = runOk(CONFIG_CLI, [
      'hooks', '--settings', settings, '--node', nodeBin, '--entry', entry, '--runtime-root', runtimeRoot,
    ]) as HooksSettings

    expect(existsSync(settings)).toBe(false) // the command never writes --settings itself
    const events = result.hooks!
    expect(Object.keys(events).sort()).toEqual(['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    expect(events.SessionStart![0]!.matcher).toBe('startup|resume')
    expect(events.Notification![0]!.hooks[0]!.args).toEqual([entry, 'notification'])
    expect(events.Notification![0]!.hooks[0]!.command).toBe(nodeBin)
    expect(events.Stop![0]!.hooks.map((h) => h.args[1])).toEqual(['stop', 'watch'])
    expect(events.Stop![0]!.hooks[1]!.asyncRewake).toBe(true)
  })

  it('upgrades cleanly across a NEW runtimeId under the same runtimeRoot without --force', () => {
    const { runtimeRoot, nodeBin: node1, entry: entry1 } = installedHookRuntime({ packageVersion: '1.0.0' })
    const settings = join(tmp('hooks-upgrade-'), 'settings.json')
    const first = runOk(CONFIG_CLI, [
      'hooks', '--settings', settings, '--node', node1, '--entry', entry1, '--runtime-root', runtimeRoot,
    ])
    writeFileSync(settings, JSON.stringify(first))

    // A second install under the SAME runtimeRoot, a different runtimeId (a version bump).
    const payloadRoot2 = tmp('hooks-payload2-')
    mkdirSync(join(payloadRoot2, 'bin'), { recursive: true })
    mkdirSync(join(payloadRoot2, 'dist'), { recursive: true })
    writeFileSync(join(payloadRoot2, 'bin', 'node'), 'fake node binary v2\n')
    writeFileSync(join(payloadRoot2, 'dist', 'hook-cli.js'), 'console.log("hook v2")\n')
    chmodSync(join(payloadRoot2, 'bin', 'node'), 0o755)
    chmodSync(join(payloadRoot2, 'dist', 'hook-cli.js'), 0o644)
    buildAndWriteManifest(payloadRoot2, { product: 'agent-inbox-runtime', packageVersion: '1.1.0', entrypoints: ['dist/hook-cli.js'] })
    const install2 = runOk(PAYLOAD_CLI, ['install', '--payload-root', payloadRoot2, '--runtime-root', runtimeRoot]) as { path: string }
    const node2 = join(install2.path, 'bin', 'node')
    const entry2 = join(install2.path, 'dist', 'hook-cli.js')

    const upgraded = runOk(CONFIG_CLI, [
      'hooks', '--settings', settings, '--node', node2, '--entry', entry2, '--runtime-root', runtimeRoot,
    ]) as HooksSettings

    // Exactly one Stop group survives (the old one was recognized and replaced, not appended as a sibling).
    expect(upgraded.hooks!.Stop!).toHaveLength(1)
    expect(upgraded.hooks!.Stop![0]!.hooks[0]!.command).toBe(node2)
    expect(upgraded.hooks!.Stop![0]!.hooks[0]!.args[0]).toBe(entry2)
  })

  it('refuses to touch existing hook entries whose ownership is custom, without --force', () => {
    const { runtimeRoot, nodeBin, entry } = installedHookRuntime()
    const settings = join(tmp('hooks-custom-'), 'settings.json')
    const customSettings: HooksSettings = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/env', args: ['/some/custom/hook-cli.js', 'stop'], timeout: 10 }] }] },
    }
    writeFileSync(settings, JSON.stringify(customSettings))
    const before = readFileSync(settings, 'utf8')

    const result = runFail(CONFIG_CLI, [
      'hooks', '--settings', settings, '--node', nodeBin, '--entry', entry, '--runtime-root', runtimeRoot,
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/ownership status/)
    expect(result.stderr).toMatch(/--force/)
    expect(readFileSync(settings, 'utf8')).toBe(before) // never touched on refusal

    const forced = runOk(CONFIG_CLI, [
      'hooks', '--settings', settings, '--node', nodeBin, '--entry', entry, '--runtime-root', runtimeRoot, '--force',
    ]) as HooksSettings
    expect(forced.hooks!.Stop!).toHaveLength(1)
    expect(forced.hooks!.Stop![0]!.hooks[0]!.command).toBe(nodeBin)
  })

  it('treats existing candidate entries as unknown (and gates on --force) when --runtime-root is omitted', () => {
    const { nodeBin, entry } = installedHookRuntime()
    const settings = join(tmp('hooks-noroot-'), 'settings.json')
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: nodeBin, args: [entry, 'stop'], timeout: 10 }] }] } }))

    const result = runFail(CONFIG_CLI, ['hooks', '--settings', settings, '--node', nodeBin, '--entry', entry])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/unknown/)

    const forced = runOk(CONFIG_CLI, ['hooks', '--settings', settings, '--node', nodeBin, '--entry', entry, '--force']) as HooksSettings
    expect(forced.hooks!.Stop!).toHaveLength(1)
  })

  it('--uninstall strips only agent-inbox-owned entries and leaves siblings (another tool\'s hooks) untouched', () => {
    const { runtimeRoot, nodeBin, entry } = installedHookRuntime()
    const settings = join(tmp('hooks-uninstall-'), 'settings.json')
    const installed = runOk(CONFIG_CLI, ['hooks', '--settings', settings, '--node', nodeBin, '--entry', entry, '--runtime-root', runtimeRoot]) as HooksSettings
    // Add an unrelated sibling hook to the same Stop event, and an unrelated top-level key.
    installed.hooks!.Stop!.push({ hooks: [{ type: 'command', command: 'echo', args: ['unrelated'], timeout: 5 } as unknown as HookEntry] })
    ;(installed as Record<string, unknown>).unrelatedTopLevelKey = 'keep-me'
    writeFileSync(settings, JSON.stringify(installed))

    const result = runOk(CONFIG_CLI, ['hooks', '--settings', settings, '--entry', entry, '--uninstall', '--runtime-root', runtimeRoot]) as HooksSettings
    expect(result.hooks!.Notification).toBeUndefined()
    expect(result.hooks!.SessionStart).toBeUndefined()
    expect(result.hooks!.Stop).toHaveLength(1) // only the sibling group remains
    expect(result.hooks!.Stop![0]!.hooks[0]!.args).toEqual(['unrelated'])
    expect((result as Record<string, unknown>).unrelatedTopLevelKey).toBe('keep-me')
  })

  it('--uninstall on a settings file with no agent-inbox entries at all is a harmless no-op', () => {
    const settings = join(tmp('hooks-uninstall-noop-'), 'settings.json')
    const untouched: HooksSettings = { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo', args: ['hi'], timeout: 5 } as unknown as HookEntry] }] } }
    writeFileSync(settings, JSON.stringify(untouched))

    const result = runOk(CONFIG_CLI, ['hooks', '--settings', settings, '--entry', '/wherever/hook-cli.js', '--uninstall']) as HooksSettings
    expect(result).toEqual(untouched)
  })

  it('--migrate also strips the two legacy hand-written .sh Stop hooks', () => {
    const { runtimeRoot, nodeBin, entry } = installedHookRuntime()
    const settings = join(tmp('hooks-migrate-'), 'settings.json')
    const legacy: HooksSettings = {
      hooks: {
        Stop: [{ hooks: [
          { type: 'command', command: '/Users/me/.claude/hooks/agent-inbox-pending.sh', args: [], timeout: 10 },
          { type: 'command', command: '/Users/me/.claude/hooks/agent-inbox-watch.sh', args: [], timeout: 1800 },
        ] }],
      },
    }
    writeFileSync(settings, JSON.stringify(legacy))

    const withoutMigrate = runOk(CONFIG_CLI, ['hooks', '--settings', settings, '--node', nodeBin, '--entry', entry, '--runtime-root', runtimeRoot]) as HooksSettings
    // Legacy entries are a different shape (no known subcommand as args[1]), so they are
    // NOT candidates and sit alongside our fresh block as a sibling group when --migrate is absent.
    expect(withoutMigrate.hooks!.Stop!.some((g) => g.hooks.some((h) => h.command.includes('agent-inbox-pending.sh')))).toBe(true)

    const migrated = runOk(CONFIG_CLI, [
      'hooks', '--settings', settings, '--node', nodeBin, '--entry', entry, '--runtime-root', runtimeRoot, '--migrate',
    ]) as HooksSettings
    expect(migrated.hooks!.Stop!.some((g) => g.hooks.some((h) => /agent-inbox-(pending|watch)\.sh/.test(h.command)))).toBe(false)
    expect(migrated.hooks!.Stop!.some((g) => g.hooks.some((h) => h.args[1] === 'watch' && h.command === nodeBin))).toBe(true)
  })

  it('rejects an unparseable --settings file with an actionable message, exit 1, and never overwrites it', () => {
    const { runtimeRoot, nodeBin, entry } = installedHookRuntime()
    const settings = join(tmp('hooks-invalid-'), 'settings.json')
    writeFileSync(settings, 'not json at all')

    const result = runFail(CONFIG_CLI, ['hooks', '--settings', settings, '--node', nodeBin, '--entry', entry, '--runtime-root', runtimeRoot])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/not valid JSON/)
    expect(readFileSync(settings, 'utf8')).toBe('not json at all')
  })

  it('rejects usage errors with exit code 2: missing --settings, missing --entry, missing --node without --uninstall', () => {
    expect(runFail(CONFIG_CLI, ['hooks', '--node', 'x', '--entry', 'y']).status).toBe(2)
    expect(runFail(CONFIG_CLI, ['hooks', '--settings', 's.json', '--node', 'x']).status).toBe(2)
    expect(runFail(CONFIG_CLI, ['hooks', '--settings', 's.json', '--entry', 'y']).status).toBe(2)
    // --uninstall does not require --node.
    const settings = join(tmp('hooks-usage-uninstall-'), 'settings.json')
    expect(runCli(CONFIG_CLI, ['hooks', '--settings', settings, '--entry', 'y', '--uninstall']).status).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// stage-runtime.mjs — node distribution validation (no real x64-on-arm64
// build required: a fixture "node" stands in for the real distribution).
// ═══════════════════════════════════════════════════════════════════════
describe('stage-runtime --check-only: validates the node-root distribution before ever staging anything', () => {
  function fakeNodeRoot(
    platform: 'darwin' | 'linux' | 'win32' = 'darwin',
  ): string {
    const root = tmp('fake-node-root-')
    const nodeBin = platform === 'win32' ? join(root, 'node.exe') : join(root, 'bin', 'node')
    mkdirSync(dirname(nodeBin), { recursive: true })
    copyFileSync(FAKE_NODE_FIXTURE, nodeBin)
    chmodSync(nodeBin, 0o755)
    return root
  }

  it('accepts a Node 24 darwin/arm64 distribution matching the requested platform/arch', () => {
    const root = fakeNodeRoot()
    const result = runOk(STAGE_CLI, ['--node-root', root, '--platform', 'darwin', '--arch', 'arm64', '--check-only'], {
      ...process.env, FAKE_PLATFORM: 'darwin', FAKE_ARCH: 'arm64', FAKE_VERSION: 'v24.18.0',
    }) as { ok: boolean; version: string }
    expect(result.ok).toBe(true)
    expect(result.version).toBe('v24.18.0')
  })

  it('rejects a distribution whose major version is not 24', () => {
    const root = fakeNodeRoot()
    const result = runFail(STAGE_CLI, ['--node-root', root, '--platform', 'darwin', '--arch', 'arm64', '--check-only'], {
      ...process.env, FAKE_PLATFORM: 'darwin', FAKE_ARCH: 'arm64', FAKE_VERSION: 'v22.10.0',
    })
    expect(result.stderr).toMatch(/requires Node 24/)
  })

  it('rejects a distribution whose own reported arch does not match the requested --arch', () => {
    const root = fakeNodeRoot()
    const result = runFail(STAGE_CLI, ['--node-root', root, '--platform', 'darwin', '--arch', 'arm64', '--check-only'], {
      ...process.env, FAKE_PLATFORM: 'darwin', FAKE_ARCH: 'x64', FAKE_VERSION: 'v24.18.0',
    })
    expect(result.stderr).toMatch(/reports darwin\/x64, not the requested darwin\/arm64/)
  })

  it('rejects a distribution whose own reported platform does not match the requested --platform', () => {
    const root = fakeNodeRoot()
    const result = runFail(STAGE_CLI, ['--node-root', root, '--platform', 'darwin', '--arch', 'arm64', '--check-only'], {
      ...process.env, FAKE_PLATFORM: 'linux', FAKE_ARCH: 'arm64', FAKE_VERSION: 'v24.18.0',
    })
    expect(result.stderr).toMatch(/reports linux\/arm64, not the requested darwin\/arm64/)
  })

  it('accepts the descriptor-defined Linux executable layout', () => {
    const linuxRoot = fakeNodeRoot('linux')
    expect(runOk(STAGE_CLI, [
      '--node-root', linuxRoot, '--platform', 'linux', '--arch', 'x64', '--check-only',
    ], {
      ...process.env, FAKE_PLATFORM: 'linux', FAKE_ARCH: 'x64', FAKE_VERSION: 'v24.18.0',
    })).toMatchObject({ ok: true, nodeBin: join(linuxRoot, 'bin', 'node') })
  })

  it('rejects an unsupported target before ever touching the node-root', () => {
    const result = runFail(STAGE_CLI, ['--node-root', '/nonexistent', '--platform', 'freebsd', '--arch', 'x64', '--check-only'])
    expect(result.stderr).toMatch(/unknown runtime target/)
  })

  it('rejects an unsupported requested --arch', () => {
    const root = fakeNodeRoot()
    const result = runFail(STAGE_CLI, ['--node-root', root, '--platform', 'darwin', '--arch', 'arm', '--check-only'])
    expect(result.stderr).toMatch(/unknown runtime target/)
  })

  it('rejects a --node-root with no bin/node at all', () => {
    const root = tmp('empty-node-root-')
    const result = runFail(STAGE_CLI, ['--node-root', root, '--platform', 'darwin', '--arch', 'arm64', '--check-only'])
    expect(result.stderr).toMatch(/no node binary at/)
  })

  it('requires --output unless --check-only is given', () => {
    const root = fakeNodeRoot()
    const result = runFail(STAGE_CLI, ['--node-root', root, '--platform', 'darwin', '--arch', 'arm64'])
    expect(result.stderr).toMatch(/--output is required/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// stage-runtime.mjs — full staging: allowScripts passthrough, lifecycle
// scripts actually running, and the pre-publish selftest gate (correction
// #1). Unlike the --check-only tests above (which stand in a fake node
// fixture because they only need probeNodeDistribution() to succeed), a
// full stage genuinely runs `npm ci` and needs the REAL distribution's own
// npm — so this block is skipped outright if the Node running this test
// suite is not itself a full, unpacked distribution (e.g. an fnm-managed
// install) with the layout stageInto() expects. Nothing here needs network
// access: the one dependency the fixture repo declares is a locally packed
// tarball referenced by an ABSOLUTE `file:` path, which `npm ci` reads
// straight off disk regardless of which directory it is run from.
// ═══════════════════════════════════════════════════════════════════════
function realNodeDistRoot(): string | undefined {
  const root = dirname(dirname(process.execPath))
  const nodeBin = join(root, 'bin', 'node')
  const npmCli = join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const license = join(root, 'LICENSE')
  return existsSync(nodeBin) && existsSync(npmCli) && existsSync(license) ? root : undefined
}

const REAL_NODE_ROOT = realNodeDistRoot()

/**
 * A minimal fixture repo root stage-runtime.mjs can stage end to end:
 *  - package.json declares ONE dependency, a locally `npm pack`-ed tarball
 *    referenced by its absolute path (so `npm ci` never touches the
 *    network), whose own postinstall script writes a marker file — proving
 *    lifecycle scripts actually run now that --ignore-scripts is gone.
 *  - an `allowScripts` entry for that same package, to prove it survives
 *    into the staged package.json (buildRuntimePackageJson()'s passthrough).
 *  - dist/hook-cli.js is a tiny stand-in whose `selftest` subcommand exits
 *    0 or 1 depending on the FAKE_SELFTEST_FAIL env var, so the pre-publish
 *    gate (runStagedSelftest()) can be driven both ways deterministically.
 *  - placeholder scripts/docs satisfying stageInto()'s REQUIRED_SCRIPTS and
 *    REQUIRED_DOCS lists (their content is never inspected, only presence).
 */
function buildFixtureRepoRoot(): string {
  const repoRoot = tmp('stage-fixture-repo-')
  const nodeBin = join(REAL_NODE_ROOT as string, 'bin', 'node')
  const npmCli = join(REAL_NODE_ROOT as string, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')

  const markerSrc = join(repoRoot, '.marker-pkg-src')
  const markerTarballs = join(repoRoot, '.marker-pkg-tarballs')
  mkdirSync(markerSrc, { recursive: true })
  mkdirSync(markerTarballs, { recursive: true })
  writeFileSync(join(markerSrc, 'package.json'), JSON.stringify({
    name: 'marker-pkg', version: '1.0.0', scripts: { postinstall: 'node postinstall.js' },
  }, null, 2))
  writeFileSync(
    join(markerSrc, 'postinstall.js'),
    "require('fs').writeFileSync(require('path').join(__dirname, 'postinstall-ran.marker'), 'ok\\n')\n",
  )
  execFileSync(nodeBin, [npmCli, 'pack', '--pack-destination', markerTarballs], {
    cwd: markerSrc, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  })
  const tarball = join(markerTarballs, 'marker-pkg-1.0.0.tgz')
  if (!existsSync(tarball)) throw new Error(`fixture setup: expected tarball missing at ${tarball}`)

  mkdirSync(join(repoRoot, 'dist'), { recursive: true })
  mkdirSync(join(repoRoot, 'scripts'), { recursive: true })
  mkdirSync(join(repoRoot, 'docs', 'instructions'), { recursive: true })

  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    name: 'stage-fixture-runtime',
    version: '0.0.1-test',
    private: true,
    type: 'module',
    bin: { 'agent-inbox-runtime': './dist/hook-cli.js' },
    dependencies: { 'marker-pkg': `file:${tarball}` },
    allowScripts: { 'marker-pkg@1.0.0': true },
  }, null, 2))
  writeFileSync(join(repoRoot, 'LICENSE'), 'fixture Agent Inbox license\n')

  // Real lockfile, generated by the SAME distribution's npm that will later
  // run `npm ci` during staging — hand-writing one would be fragile across
  // npm versions.
  execFileSync(nodeBin, [npmCli, 'install', '--package-lock-only', '--no-audit', '--no-fund'], {
    cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  })

  writeFileSync(
    join(repoRoot, 'dist', 'hook-cli.js'),
    "#!/usr/bin/env node\n"
    + "if (process.argv[2] === 'selftest') {\n"
    + "  if (process.env.FAKE_SELFTEST_FAIL === '1') { console.error('fake selftest failure'); process.exit(1) }\n"
    + "  console.log('selftest ok'); process.exit(0)\n"
    + "}\n"
    + "console.error('unknown subcommand'); process.exit(1)\n",
  )

  for (const name of ['install-agents.sh', 'install-hooks.sh', 'runtime-payload.mjs', 'runtime-config.mjs']) {
    writeFileSync(join(repoRoot, 'scripts', name), `# fixture placeholder for ${name}\n`)
  }
  writeFileSync(join(repoRoot, 'docs', 'reporting-snippet.md'), '# fixture reporting snippet\n')
  writeFileSync(join(repoRoot, 'docs', 'hooks.md'), '# fixture hooks doc\n')
  writeFileSync(join(repoRoot, 'docs', 'instructions', 'claude-code.md'), '# fixture claude instructions\n')
  writeFileSync(join(repoRoot, 'docs', 'instructions', 'copilot-cli.md'), '# fixture copilot instructions\n')

  return repoRoot
}

describe.skipIf(!REAL_NODE_ROOT || !['darwin', 'linux'].includes(process.platform))(
  'stage-runtime full staging: allowScripts passthrough + pre-publish selftest gate (correction #1)',
  () => {
    it(
      'stages end to end: scripts run (postinstall marker present), allowScripts carried over, ' +
      'selftest gate passes, manifest verifies, output published',
      () => {
        const repoRoot = buildFixtureRepoRoot()
        const outputParent = tmp('stage-full-happy-')
        const output = join(outputParent, 'runtime')

        const result = runOk(STAGE_CLI, [
          '--node-root', REAL_NODE_ROOT as string, '--platform', process.platform, '--arch', process.arch,
          '--output', output, '--repo-root', repoRoot,
        ]) as { ok: boolean; runtimeId: string; output: string }

        expect(result.ok).toBe(true)
        expect(existsSync(output)).toBe(true)
        expect(existsSync(join(output, 'runtime-manifest.json'))).toBe(true)
        expect(existsSync(join(output, 'bin', 'node'))).toBe(true)
        expect(statSync(join(output, 'bin', 'node')).mode & 0o777).toBe(0o755)
        expect(existsSync(join(output, 'node.exe'))).toBe(false)
        expect(readFileSync(join(output, 'LICENSE.agent-inbox'), 'utf8')).toBe('fixture Agent Inbox license\n')

        // The manifest verifies cleanly on its own — the same gate
        // installRuntime() applies before ever publishing to a runtime root.
        runOk(PAYLOAD_CLI, ['verify', '--root', output])

        // allowScripts passthrough (buildRuntimePackageJson()).
        const stagedPkg = JSON.parse(readFileSync(join(output, 'package.json'), 'utf8'))
        expect(stagedPkg.allowScripts).toEqual({ 'marker-pkg@1.0.0': true })

        // Lifecycle scripts actually ran — proves --ignore-scripts was
        // dropped: marker-pkg's own postinstall wrote this file.
        expect(existsSync(join(output, 'node_modules', 'marker-pkg', 'postinstall-ran.marker'))).toBe(true)

        // @electron/packager always strips these names. They must be removed
        // before manifesting or every copied app payload fails verification.
        expect(existsSync(join(output, 'package-lock.json'))).toBe(false)
        const manifest = JSON.parse(readFileSync(join(output, 'runtime-manifest.json'), 'utf8')) as {
          files: Array<{ path: string; mode: number }>
        }
        expect(manifest.files).toContainEqual(expect.objectContaining({ path: 'bin/node', mode: 0o755 }))
        expect(manifest.files.some((file) => file.path === 'node.exe')).toBe(false)
        for (const file of manifest.files) {
          expect(file.path).not.toMatch(/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/)
          expect(file.path).not.toMatch(/(^|\/)(\.git|\.bin|node_gyp_bins)(\/|$)|\.o(bj)?$/)
        }

        // No leftover staging temp directory beside the published output.
        const siblings = readdirSync(outputParent)
        expect(siblings.some((e) => e.startsWith('.stage-runtime-'))).toBe(false)
      },
      30_000,
    )

    it(
      'refuses to publish anything when the staged selftest fails: no output, no leftover staging temp dir',
      () => {
        const repoRoot = buildFixtureRepoRoot()
        const outputParent = tmp('stage-full-fail-')
        const output = join(outputParent, 'runtime')

        const result = runFail(STAGE_CLI, [
          '--node-root', REAL_NODE_ROOT as string, '--platform', process.platform, '--arch', process.arch,
          '--output', output, '--repo-root', repoRoot,
        ], { ...process.env, FAKE_SELFTEST_FAIL: '1' })

        expect(result.stderr).toMatch(/failed its selftest/)
        expect(existsSync(output)).toBe(false)
        const siblings = readdirSync(outputParent)
        expect(siblings.some((e) => e.startsWith('.stage-runtime-'))).toBe(false)
      },
      30_000,
    )
  },
)


// ═══════════════════════════════════════════════════════════════════════
// Entrypoint detection — CLIs must still run their `main()` when reached
// through a symlinked ancestor directory, not only via their literal,
// already-canonical repo path.
// ═══════════════════════════════════════════════════════════════════════
describe('main-entrypoint detection: symlinked ancestor / alias paths', () => {
  it('runtime-payload.mjs runs its CLI (not a silent no-op) when invoked through a symlinked parent directory', () => {
    const [aliasedPayloadCli] = createSymlinkedAlias([PAYLOAD_CLI])
    const payloadRoot = tmp('sym-payload-')
    buildFixturePayload(payloadRoot)

    const result = runOk(aliasedPayloadCli!, manifestArgs(payloadRoot)) as { runtimeId?: string; files?: unknown[] }
    expect(result.runtimeId).toBeTruthy()
    expect(Array.isArray(result.files)).toBe(true)
    expect((result.files as unknown[]).length).toBeGreaterThan(0)
  })

  it('runtime-config.mjs runs its CLI (not a silent no-op) when invoked through a symlinked parent directory', () => {
    // runtime-config.mjs imports from './runtime-payload.mjs' — both must be
    // copied into the same aliased directory for the relative import to
    // resolve once reached through the alias.
    const [aliasedConfigCli] = createSymlinkedAlias([CONFIG_CLI, PAYLOAD_CLI])
    const dir = tmp('sym-config-')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({}))

    const result = runOk(aliasedConfigCli!, ['registration', '--file', configFile, '--runtime-root', dir]) as { status: string }
    expect(result.status).toBe('absent')
  })

  it('stage-runtime.mjs runs its CLI (reaches real argument validation, not a silent exit 0) when invoked through a symlinked parent directory', () => {
    // stage-runtime.mjs also imports from './runtime-payload.mjs'.
    const [aliasedStageCli] = createSymlinkedAlias([STAGE_CLI, PAYLOAD_CLI])

    // No flags at all: if main() truly ran, this must fail loudly with a
    // usage error on stderr. The bug this guards against was a silent exit
    // 0 with empty stdout/stderr — main() never even entered.
    const result = runFail(aliasedStageCli!, [])
    expect(result.status).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
