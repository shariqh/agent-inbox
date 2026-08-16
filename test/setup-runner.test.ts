import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const PAYLOAD_CLI = resolve(import.meta.dirname, '..', 'scripts', 'runtime-payload.mjs')
const {
  canRunSetup,
  installerRepoRoot,
  isTrustedSetupSender,
  readSetupInfo,
  runAgentInstall,
  runtimeKey,
  selectRuntimePayload: selectRuntimePayloadRaw,
} = require('../electron/setup-runner.cjs') as {
  canRunSetup(senderUrl: string, viewerUrl: string, senderId: number, authorizedWebContentsId: number | null): boolean
  installerRepoRoot(appRoot: string): string | null
  isTrustedSetupSender(senderUrl: string, viewerUrl: string): boolean
  readSetupInfo(appRoot: string): unknown
  runtimeKey(platform: string, arch: string): string
  selectRuntimePayload(opts: {
    appRoot: string
    platform?: string
    arch?: string
    info?: unknown
  }): { ok: boolean; reason?: string; key: string; path?: string; relativePath?: string; digest?: string }
  runAgentInstall(opts: {
    repoRoot: string
    target: string
    runtimePayload?: { path: string; digest: string; packageVersion: string } | null
    env?: NodeJS.ProcessEnv
    maxOutput?: number
    timeoutMs?: number
    spawnImpl?: (...args: unknown[]) => never
    onCancel?: (cancel: () => void) => void
  }): Promise<{ ok: boolean; exitCode: number | null; output: string; target: string; timedOut: boolean; cancelled: boolean }>
}

function selectRuntimePayload(opts: {
  appRoot: string
  platform?: string
  arch?: string
  info?: unknown
}): { ok: boolean; reason?: string; key: string; path?: string; relativePath?: string; digest?: string } {
  const info = opts.info as Record<string, unknown> | null | undefined
  return selectRuntimePayloadRaw({
    ...opts,
    info: info?.runtimePayloads && !info.version ? { version: '1.2.3', ...info } : info,
  })
}

function fixture(script: string): string {
  const root = mkdtempSync(join(tmpdir(), 'setup-runner-'))
  const scripts = join(root, 'scripts')
  mkdirSync(scripts)
  const installer = join(scripts, 'install-agents.sh')
  writeFileSync(installer, script)
  chmodSync(installer, 0o755)
  return root
}

/** Stages a real runtime PAYLOAD DIRECTORY under `appRoot` (issue #74) —
 *  scripts/runtime-payload.mjs's own on-disk shape: a `runtime-manifest.json`
 *  naming this payload's `platform`/`arch`, plus (by default) an installer
 *  script, since `selectRuntimePayload` requires both. The digest baked into
 *  `setup-info.json` is over the manifest FILE's real bytes, exactly as
 *  `scripts/write-setup-info.mjs --release` computes it — never a caller-
 *  supplied string. */
function stagePayloadDir(
  appRoot: string,
  relDir: string,
  opts: {
    platform: string
    arch: string
    withInstaller?: boolean
    installerScript?: string
    product?: string
    packageVersion?: string
    nodeVersion?: string
    nodeModulesAbi?: string
    omitEntrypoint?: string
    omitFile?: string
  } = { platform: 'darwin', arch: 'arm64' },
): { path: string; digest: string } {
  const { platform, arch, withInstaller = true, installerScript = '#!/bin/bash\necho noop\n' } = opts
  const dir = join(appRoot, relDir)
  mkdirSync(dir, { recursive: true })
  if (withInstaller) {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    if (opts.omitFile !== 'scripts/install-agents.sh') writeFileSync(join(dir, 'scripts', 'install-agents.sh'), installerScript)
    if (opts.omitFile !== 'scripts/runtime-payload.mjs') writeFileSync(join(dir, 'scripts', 'runtime-payload.mjs'), '// verifier helper\n')
    if (opts.omitFile !== 'scripts/runtime-config.mjs') writeFileSync(join(dir, 'scripts', 'runtime-config.mjs'), '// config helper\n')
    mkdirSync(join(dir, 'dist'), { recursive: true })
    if (opts.omitFile !== 'dist/mcp-server.js') writeFileSync(join(dir, 'dist', 'mcp-server.js'), '// mcp\n')
    if (opts.omitFile !== 'dist/hook-cli.js') writeFileSync(join(dir, 'dist', 'hook-cli.js'), '// hook\n')
    if (opts.omitFile !== 'dist/watch-cli.js') writeFileSync(join(dir, 'dist', 'watch-cli.js'), '// watch\n')
    mkdirSync(join(dir, 'node_modules', 'better-sqlite3', 'build', 'Release'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'native-addon\n')
  } else {
    writeFileSync(join(dir, 'payload.txt'), 'no installer\n')
  }
  const args = [
    PAYLOAD_CLI,
    'manifest',
    '--root', dir,
    '--product', opts.product ?? 'agent-inbox-runtime',
    '--package-version', opts.packageVersion ?? '1.2.3',
    '--source-commit', 'deadbeef',
    '--platform', platform,
    '--arch', arch,
    '--node-version', opts.nodeVersion ?? process.version,
    '--node-modules-abi', opts.nodeModulesAbi ?? process.versions.modules,
  ]
  const entrypoints = withInstaller
    ? ['dist/mcp-server.js', 'dist/hook-cli.js', 'dist/watch-cli.js'].filter((entry) => entry !== opts.omitEntrypoint)
    : ['payload.txt']
  for (const entrypoint of entrypoints) args.push('--entrypoint', entrypoint)
  execFileSync(process.execPath, args)
  const manifestJson = readFileSync(join(dir, 'runtime-manifest.json'), 'utf8')
  const digest = createHash('sha256').update(manifestJson).digest('hex')
  return { path: relDir, digest: `sha256:${digest}` }
}

describe('Electron one-click setup runner', () => {
  it('accepts only the exact local viewer origin', () => {
    expect(isTrustedSetupSender('http://127.0.0.1:4319/', 'http://127.0.0.1:4319/')).toBe(true)
    expect(isTrustedSetupSender('http://127.0.0.1:4319/setup', 'http://127.0.0.1:4319/')).toBe(true)
    expect(isTrustedSetupSender('http://127.0.0.1:4319.evil.example/', 'http://127.0.0.1:4319/')).toBe(false)
    expect(isTrustedSetupSender('https://127.0.0.1:4319/', 'http://127.0.0.1:4319/')).toBe(false)
    expect(isTrustedSetupSender('http://localhost:4319/', 'http://127.0.0.1:4319/')).toBe(false)
    expect(isTrustedSetupSender('not a url', 'http://127.0.0.1:4319/')).toBe(false)
    expect(canRunSetup('http://127.0.0.1:4319/', 'http://127.0.0.1:4319/', 7, 7)).toBe(true)
    expect(canRunSetup('http://127.0.0.1:4319/', 'http://127.0.0.1:4319/', 7, 8)).toBe(false)
  })

  it('resolves the packaged checkout from setup-info and refuses a missing installer', () => {
    const packaged = mkdtempSync(join(tmpdir(), 'setup-packaged-'))
    const checkout = fixture('exit 0\n')
    writeFileSync(join(packaged, 'setup-info.json'), JSON.stringify({ repoRoot: checkout }))

    expect(installerRepoRoot(packaged)).toBe(checkout)
    expect(installerRepoRoot(mkdtempSync(join(tmpdir(), 'setup-missing-')))).toBe(null)
  })

  it('spawns only the fixed installer with validated target arguments', async () => {
    const argsFile = join(tmpdir(), `setup-args-${process.pid}-${Date.now()}`)
    const root = fixture(`#!/bin/bash
printf '%s\\n' "$@" > "$ARGS_FILE"
printf 'installed %s\\n' "$3"
`)

    const result = await runAgentInstall({
      repoRoot: root,
      target: 'copilot',
      env: { ...process.env, ARGS_FILE: argsFile },
    })

    expect(result).toMatchObject({ ok: true, exitCode: 0, target: 'copilot', timedOut: false })
    expect(readFileSync(argsFile, 'utf8')).toBe('--apply\n--target\ncopilot\n')
    expect(result.output).toContain('installed copilot')
  })

  it('rejects arbitrary targets without spawning anything', async () => {
    const root = fixture('touch "$SHOULD_NOT_EXIST"\n')
    const marker = join(root, 'spawned')

    const result = await runAgentInstall({
      repoRoot: root,
      target: '../anything',
      env: { ...process.env, SHOULD_NOT_EXIST: marker },
    })

    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/invalid setup target/i)
  })

  it('bounds subprocess output while preserving the final result', async () => {
    const root = fixture(`#!/bin/bash
yes x | head -c 4096
printf '\\nfinished\\n'
`)

    const result = await runAgentInstall({ repoRoot: root, target: 'all', maxOutput: 512 })

    expect(result.ok).toBe(true)
    expect(result.output.length).toBeLessThan(600)
    expect(result.output).toContain('output truncated')
    expect(result.output).toContain('finished')
  })

  it('cancels the process group and waits for its signal cleanup', async () => {
    const root = fixture(`#!/bin/bash
trap 'printf "rolled back\\n"; exit 130' TERM INT
printf 'started\\n'
while :; do sleep 1; done
`)
    let cancel = () => {}
    const promise = runAgentInstall({
      repoRoot: root,
      target: 'claude',
      onCancel(fn) { cancel = fn },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    cancel()
    const result = await promise

    expect(result).toMatchObject({ ok: false, cancelled: true, timedOut: false })
    expect(result.output).toContain('Agent Inbox is closing')
    expect(result.output).toContain('rolled back')
  })

  it('wires the bridge through an isolated preload rather than an HTTP command route', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'electron', 'main.cjs'), 'utf8')
    const preload = readFileSync(join(import.meta.dirname, '..', 'electron', 'setup-preload.cjs'), 'utf8')

    expect(main).toContain("ipcMain.handle('agent-inbox:install'")
    expect(main).toContain('canRunSetup(senderUrl, URL_BASE, event.sender.id, setupInstallWebContentsId)')
    expect(main).toContain('await waitForOwnership()')
    expect(main).toContain("const VIEWER_HOST = '127.0.0.1'")
    expect(main).toContain('const URL_BASE = `http://${VIEWER_HOST}:${PORT}/`')
    expect(main).toContain("const BOUNDARY_HEADER = 'x-agent-inbox-local-boundary'")
    expect(main).toContain('classifyReuse(probeAny, probe, sleep, REUSE_CONFIRM_DELAY_MS)')
    expect(main).toContain("reuseState === 'incompatible'")
    expect(main).not.toContain('setupInstallEnabled = true\n        if (!win.isDestroyed())')
    expect(main).toContain("app.on('before-quit'")
    expect(main).toContain('contextIsolation: true')
    expect(main).toContain('nodeIntegration: false')
    expect(main).toContain("preload: path.join(__dirname, 'setup-preload.cjs')")
    expect(main).toContain("accelerator: 'CommandOrControl+,'")
    expect(main).toContain("win.webContents.send('agent-inbox:toggle-settings')")
    expect(main).toContain('const setupWindowWebContentsId = win.webContents.id')
    expect(main).toContain('setupInstallWebContentsId === setupWindowWebContentsId')
    expect(preload).toContain("contextBridge.exposeInMainWorld('agentInboxSetup'")
    expect(preload).toContain('onToggleSettings')
    expect(preload).not.toContain('child_process')
  })
})

// issue #74 — architecture-keyed release runtime selection. `selectRuntimePayload`
// is the ONLY place a packaged app decides which of the two shipped runtime
// tarballs applies to the machine it is running on, and it must do so with zero
// fallback: a host it does not recognise gets nothing, ever.
describe('selectRuntimePayload (issue #74)', () => {
  function releaseRoot(): { root: string; arm: { path: string; digest: string }; x64: { path: string; digest: string } } {
    const root = mkdtempSync(join(tmpdir(), 'runtime-select-'))
    const arm = stagePayloadDir(root, 'runtime/darwin-arm64', { platform: 'darwin', arch: 'arm64' })
    const x64 = stagePayloadDir(root, 'runtime/darwin-x64', { platform: 'darwin', arch: 'x64' })
    return { root, arm, x64 }
  }

  it('selects the darwin-arm64 payload directory via injected process.platform/process.arch, never uname', () => {
    const { root, arm } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': arm } },
    })
    expect(result.ok).toBe(true)
    expect(result.key).toBe('darwin-arm64')
    expect(result.relativePath).toBe('runtime/darwin-arm64')
    expect(result.path).toBe(realpathSync(join(root, 'runtime', 'darwin-arm64')))
    expect(runtimeKey('darwin', 'arm64')).toBe('darwin-arm64')
  })

  it('selects the darwin-x64 payload directory via injected process.platform/process.arch, never uname', () => {
    const { root, x64 } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'x64',
      info: { runtimePayloads: { 'darwin-x64': x64 } },
    })
    expect(result.ok).toBe(true)
    expect(result.key).toBe('darwin-x64')
    expect(runtimeKey('darwin', 'x64')).toBe('darwin-x64')
  })

  it.each([
    ['wrong product', { product: 'other-runtime' }],
    ['package version mismatch', { packageVersion: '9.9.9' }],
    ['Node 23', { nodeVersion: 'v23.11.0' }],
    ['Node 25', { nodeVersion: 'v25.0.0' }],
    ['malformed ABI', { nodeModulesAbi: 'invalid' }],
    ['wrong ABI', { nodeModulesAbi: '999' }],
    ['missing MCP entrypoint', { omitEntrypoint: 'dist/mcp-server.js' }],
    ['missing hook entrypoint', { omitEntrypoint: 'dist/hook-cli.js' }],
    ['missing watch entrypoint', { omitEntrypoint: 'dist/watch-cli.js' }],
    ['missing installer', { omitFile: 'scripts/install-agents.sh' }],
    ['missing runtime verifier', { omitFile: 'scripts/runtime-payload.mjs' }],
    ['missing config helper', { omitFile: 'scripts/runtime-config.mjs' }],
  ])('rejects %s at selection and immediately before spawn', async (_label, override) => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-identity-'))
    const payload = stagePayloadDir(root, 'runtime/darwin-arm64', {
      platform: 'darwin',
      arch: 'arm64',
      ...override,
    })
    const selected = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': payload } },
    })
    expect(selected.ok).toBe(false)

    let spawned = false
    const payloadRoot = join(root, payload.path)
    const result = await runAgentInstall({
      repoRoot: payloadRoot,
      target: 'all',
      runtimePayload: { path: payloadRoot, digest: payload.digest, packageVersion: '1.2.3' },
      spawnImpl: () => {
        spawned = true
        throw new Error('must not spawn')
      },
    })
    expect(result.ok).toBe(false)
    expect(spawned).toBe(false)
  })

  it('rejects an unsupported platform/arch with no Rosetta/uname fallback', () => {
    const { root, arm, x64 } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'x64',
      // Simulate an Apple Silicon host running under Rosetta (arch reports
      // x64) whose release only shipped the arm64 payload — must NOT fall
      // back to it.
      info: { runtimePayloads: { 'darwin-arm64': arm } },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('missing-payload')
    expect(result.key).toBe('darwin-x64')

    const linux = selectRuntimePayload({
      appRoot: root,
      platform: 'linux',
      arch: 'x64',
      info: { runtimePayloads: { 'darwin-arm64': arm, 'darwin-x64': x64 } },
    })
    expect(linux.ok).toBe(false)
    expect(linux.reason).toBe('unsupported-platform')
  })

  it('reports no-release-payloads for a dev/legacy bundle so callers fall back untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-dev-'))
    const result = selectRuntimePayload({ appRoot: root, platform: 'darwin', arch: 'arm64', info: null })
    expect(result).toMatchObject({ ok: false, reason: 'no-release-payloads' })
    const linuxDev = selectRuntimePayload({ appRoot: root, platform: 'linux', arch: 'x64', info: null })
    expect(linuxDev).toMatchObject({ ok: false, reason: 'no-release-payloads', key: 'linux-x64' })
    const legacy = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { repoRoot: '/some/checkout', nodeBin: '/some/checkout/node' },
    })
    expect(legacy).toMatchObject({ ok: false, reason: 'no-release-payloads' })
  })

  it('rejects an absolute payload path', () => {
    const { root } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: '/etc/passwd', digest: 'sha256:' + '0'.repeat(64) } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid-path' })
  })

  it('rejects a path-traversal payload path', () => {
    const { root } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: '../outside', digest: 'sha256:' + '0'.repeat(64) } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid-path' })
  })

  it('rejects a malformed digest', () => {
    const { root } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: 'runtime/darwin-arm64', digest: 'not-a-digest' } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid-digest' })
  })

  it('rejects a digest that does not match the staged runtime-manifest.json', () => {
    const { root, arm } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: arm.path, digest: 'sha256:' + '0'.repeat(64) } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'digest-mismatch' })
  })

  it.each([
    ['installer bytes', (root: string) => writeFileSync(join(root, 'scripts', 'install-agents.sh'), '#!/bin/bash\necho tampered\n')],
    ['verifier helper bytes', (root: string) => writeFileSync(join(root, 'scripts', 'runtime-payload.mjs'), '// tampered helper\n')],
    ['native addon bytes', (root: string) => writeFileSync(join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'tampered-native\n')],
    ['an extra file', (root: string) => writeFileSync(join(root, 'extra.js'), 'unmanifested\n')],
    ['a mode change', (root: string) => chmodSync(join(root, 'scripts', 'install-agents.sh'), 0o755)],
  ])('rejects %s before Setup can execute it', (_label, tamper) => {
    const { root, arm } = releaseRoot()
    tamper(join(root, arm.path))
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': arm } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'payload-integrity' })
  })

  it('rejects an external identical runtime-manifest.json symlink', () => {
    const { root, arm } = releaseRoot()
    const manifestPath = join(root, arm.path, 'runtime-manifest.json')
    const outside = join(mkdtempSync(join(tmpdir(), 'runtime-manifest-outside-')), 'runtime-manifest.json')
    writeFileSync(outside, readFileSync(manifestPath))
    rmSync(manifestPath)
    symlinkSync(outside, manifestPath)
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': arm } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'symlinked-payload' })
  })

  it('re-verifies a release payload immediately before spawn and refuses tampering', async () => {
    const { root, arm } = releaseRoot()
    const payloadRoot = join(root, arm.path)
    const marker = join(root, 'spawned')
    writeFileSync(join(payloadRoot, 'scripts', 'install-agents.sh'), `#!/bin/bash\ntouch '${marker}'\n`)
    const result = await runAgentInstall({
      repoRoot: payloadRoot,
      target: 'all',
      runtimePayload: { path: payloadRoot, digest: arm.digest, packageVersion: '1.2.3' },
    })
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/integrity verification/i)
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects a missing payload directory', () => {
    const { root } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: 'runtime/does-not-exist', digest: 'sha256:' + '0'.repeat(64) } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('rejects a payload path that resolves to a file, not a directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-not-dir-'))
    mkdirSync(join(root, 'runtime'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'darwin-arm64'), 'not a directory')
    const digest = createHash('sha256').update('not a directory').digest('hex')
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: 'runtime/darwin-arm64', digest: `sha256:${digest}` } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'not-a-directory' })
  })

  it('rejects a payload directory with no runtime-manifest.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-no-manifest-'))
    mkdirSync(join(root, 'runtime', 'darwin-arm64'), { recursive: true })
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: 'runtime/darwin-arm64', digest: 'sha256:' + '0'.repeat(64) } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'missing-manifest' })
  })

  it("rejects a manifest whose platform/arch don't match the map key it was selected under", () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-mismatch-'))
    // Staged under the darwin-arm64 key, but its own manifest says x64 — a
    // build-time mix-up that must never be trusted at selection time either.
    const payload = stagePayloadDir(root, 'runtime/darwin-arm64', { platform: 'darwin', arch: 'x64' })
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': payload } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'manifest-mismatch' })
  })

  it('rejects a payload directory with no installer script', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-no-installer-'))
    const payload = stagePayloadDir(root, 'runtime/darwin-arm64', { platform: 'darwin', arch: 'arm64', withInstaller: false })
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': payload } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'manifest-mismatch' })
  })

  it('rejects a payload directory that is itself a symlink, regardless of where it resolves', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-symlink-entry-'))
    const outside = mkdtempSync(join(tmpdir(), 'runtime-symlink-entry-outside-'))
    const payload = stagePayloadDir(outside, 'darwin-arm64', { platform: 'darwin', arch: 'arm64' })
    mkdirSync(join(root, 'runtime'), { recursive: true })
    symlinkSync(join(outside, 'darwin-arm64'), join(root, 'runtime', 'darwin-arm64'))

    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: 'runtime/darwin-arm64', digest: payload.digest } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'symlinked-payload' })
  })

  it('rejects a payload directory that escapes the app root through an ancestor symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-symlink-app-'))
    const outside = mkdtempSync(join(tmpdir(), 'runtime-symlink-outside-'))
    // The ancestor `runtime` segment is a symlink out of appRoot — the final
    // `darwin-arm64` path component itself is a real (non-symlink) directory,
    // so this is caught by REAL-path containment, not the symlinked-entry check.
    symlinkSync(outside, join(root, 'runtime'))
    const payload = stagePayloadDir(outside, 'darwin-arm64', { platform: 'darwin', arch: 'arm64' })

    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: 'runtime/darwin-arm64', digest: payload.digest } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'not-contained' })
  })

  it('resolves correctly through a symlinked app root whose real path contains a legitimate payload', () => {
    const real = mkdtempSync(join(tmpdir(), 'runtime-symlink-real-'))
    const { path: relPath, digest } = stagePayloadDir(real, 'runtime/darwin-arm64', { platform: 'darwin', arch: 'arm64' })
    const outerParent = mkdtempSync(join(tmpdir(), 'runtime-symlink-outer-'))
    const linkedAppRoot = join(outerParent, 'app-root-link')
    symlinkSync(real, linkedAppRoot)

    const result = selectRuntimePayload({
      appRoot: linkedAppRoot,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: relPath, digest } } },
    })
    // The legitimate payload still resolves correctly through the symlinked root.
    expect(result.ok).toBe(true)
  })

  it('reads setup-info.json fail-open, tolerating a missing or corrupt file', () => {
    const root = mkdtempSync(join(tmpdir(), 'setup-info-read-'))
    expect(readSetupInfo(root)).toBe(null)
    writeFileSync(join(root, 'setup-info.json'), 'not json{{{')
    expect(readSetupInfo(root)).toBe(null)
    writeFileSync(join(root, 'setup-info.json'), JSON.stringify({ schema: 2, version: '1.0.0' }))
    expect(readSetupInfo(root)).toMatchObject({ schema: 2, version: '1.0.0' })
  })
})

describe('runAgentInstall runtime payload argv (issue #74)', () => {
  it('passes explicit --runtime-source/--runtime-digest for a release install, and dev installs stay unchanged', async () => {
    const argsFile = join(tmpdir(), `setup-runtime-args-${process.pid}-${Date.now()}`)
    const root = mkdtempSync(join(tmpdir(), 'setup-runtime-payload-'))
    const payload = stagePayloadDir(root, 'runtime/darwin-arm64', {
      platform: 'darwin',
      arch: 'arm64',
      installerScript: `#!/bin/bash
printf '%s\\n' "$@" > "$ARGS_FILE"
printf 'installed %s\\n' "$3"
`,
    })
    const payloadRoot = join(root, payload.path)

    const result = await runAgentInstall({
      repoRoot: payloadRoot,
      target: 'all',
      runtimePayload: { path: payloadRoot, digest: payload.digest, packageVersion: '1.2.3' },
      env: { ...process.env, ARGS_FILE: argsFile },
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(argsFile, 'utf8')).toBe(
      `--apply\n--target\nall\n--runtime-source\n${payloadRoot}\n--runtime-digest\n${payload.digest}\n`,
    )
  })

  it('rejects a malformed runtimePayload without spawning the installer', async () => {
    const root = fixture('echo should-not-run\n')
    const result = await runAgentInstall({
      repoRoot: root,
      target: 'all',
      runtimePayload: { path: '', digest: 'sha256:' + '0'.repeat(64), packageVersion: '1.2.3' },
    })
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/invalid release runtime payload/i)
  })

  it('keeps the exact dev/legacy argv when no runtimePayload is passed', async () => {
    const argsFile = join(tmpdir(), `setup-dev-args-${process.pid}-${Date.now()}`)
    const root = fixture(`#!/bin/bash
printf '%s\\n' "$@" > "$ARGS_FILE"
`)
    await runAgentInstall({
      repoRoot: root,
      target: 'claude',
      env: { ...process.env, ARGS_FILE: argsFile },
    })
    expect(readFileSync(argsFile, 'utf8')).toBe('--apply\n--target\nclaude\n')
  })
})
