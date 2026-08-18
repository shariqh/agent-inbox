// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import type { BuildStamp } from '../../src/stamp.js'
import { bootApp, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

const PAYLOAD_CLI = resolve(import.meta.dirname, '..', '..', 'scripts', 'runtime-payload.mjs')

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  delete (window as unknown as Record<string, unknown>).agentInboxSetup
})

function open(): Database.Database {
  db = freshDb()
  return db
}

function targetSelect(): HTMLSelectElement {
  return document.querySelector('.setup-target') as HTMLSelectElement
}

async function bootSetup(): Promise<void> {
  await bootApp(open(), {
    viewer: {
      setupInfoPath: '/nonexistent/setup-info.json',
      stamp: async () => null as never,
    },
  })
  await settle()
}

describe('one-click agent setup menu', () => {
  it('offers both hosts, Claude only, and Copilot only while retaining handoff choices', async () => {
    await bootSetup()

    expect([...targetSelect().options].map((o) => [o.value, o.textContent])).toEqual([
      ['all', 'Claude Code + Copilot CLI (recommended)'],
      ['claude', 'Claude Code only'],
      ['copilot', 'Copilot CLI only'],
    ])
    expect(document.querySelector('.setup-run-btn')).toBeNull()
    expect(document.querySelector('.setup-agent-btn')?.textContent).toBe('Copy prompt for agent')
    expect(document.querySelector('.setup-command-btn')?.textContent).toBe('Copy terminal command')
    expect(document.querySelector('.setup-app-note')?.textContent).toMatch(/Electron app/i)
  })

  it('runs the selected fixed target through the Electron bridge and paints its result', async () => {
    const install = vi.fn(async (target: string) => ({
      ok: true,
      exitCode: 0,
      target,
      timedOut: false,
      output: `${target} installed`,
    }))
    Object.defineProperty(window, 'agentInboxSetup', {
      configurable: true,
      value: { available: async () => true, install },
    })
    await bootSetup()

    const select = targetSelect()
    select.value = 'copilot'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    const run = document.querySelector('.setup-run-btn') as HTMLButtonElement
    expect(run.textContent).toBe('Install Copilot CLI now')
    run.click()
    await settle()

    expect(install).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledWith('copilot')
    expect(document.querySelector('.setup-result')?.textContent).toContain('copilot installed')
    expect(document.querySelector('.setup-result')?.classList.contains('success')).toBe(true)
  })

  it('copies an agent-ready prompt for the selected target', async () => {
    const copied: string[] = []
    const writeText = vi.fn(async (text: string) => { copied.push(text) })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    await bootSetup()

    const select = targetSelect()
    select.value = 'claude'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    ;(document.querySelector('.setup-agent-btn') as HTMLButtonElement).click()
    await settle()

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(copied[0]).toContain('--target claude')
    expect(copied[0]).toMatch(/run this setup/i)
  })
})

// issue #74 — a signed release build never bakes a builder repoRoot/nodeBin
// path, so the truthful Setup API withholds the manual/direct commands until
// an installed runtime matching THIS host's exact verified payload exists.
// The real release payload (scripts/runtime-payload.mjs) is a DIRECTORY
// containing `runtime-manifest.json` — never a flat file — so every fixture
// below stages that shape.
describe('release mode (issue #74) — truthful Setup API + conditional rendering', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** Stages a release bundle whose darwin-arm64 SOURCE payload is a real,
   *  verifiable directory (manifest + installer) inside the app root — the
   *  normal, intact state of a shipped release. */
  function releaseBundle(opts: {
    product?: string
    packageVersion?: string
    nodeVersion?: string
    nodeModulesAbi?: string
    omitEntrypoint?: string
    omitFile?: string
  } = {}): {
    setupInfoPath: string
    runtimeRoot: string
    digest: string
    version: string
    payloadDir: string
    runtimeId: string
  } {
    const bundleDir = mkdtempSync(join(tmpdir(), 'release-bundle-'))
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'release-runtime-root-'))
    dirs.push(bundleDir, runtimeRoot)
    const version = '1.2.3'
    const payloadDir = join(bundleDir, 'runtime', 'darwin-arm64')
    mkdirSync(join(payloadDir, 'scripts'), { recursive: true })
    if (opts.omitFile !== 'scripts/install-agents.sh') writeFileSync(join(payloadDir, 'scripts', 'install-agents.sh'), '#!/bin/bash\necho noop\n')
    if (opts.omitFile !== 'scripts/runtime-payload.mjs') writeFileSync(join(payloadDir, 'scripts', 'runtime-payload.mjs'), '// helper\n')
    if (opts.omitFile !== 'scripts/runtime-config.mjs') writeFileSync(join(payloadDir, 'scripts', 'runtime-config.mjs'), '// config helper\n')
    if (opts.omitFile !== 'scripts/setup-filesystem.cjs') writeFileSync(join(payloadDir, 'scripts', 'setup-filesystem.cjs'), '// filesystem adapter\n')
    mkdirSync(join(payloadDir, 'bin'), { recursive: true })
    mkdirSync(join(payloadDir, 'dist'), { recursive: true })
    mkdirSync(join(payloadDir, 'node_modules', 'better-sqlite3', 'build', 'Release'), { recursive: true })
    writeFileSync(join(payloadDir, 'bin', 'node'), '#!/bin/sh\n')
    if (opts.omitFile !== 'dist/mcp-server.js') writeFileSync(join(payloadDir, 'dist', 'mcp-server.js'), '// mcp\n')
    if (opts.omitFile !== 'dist/hook-cli.js') writeFileSync(join(payloadDir, 'dist', 'hook-cli.js'), '// hook\n')
    if (opts.omitFile !== 'dist/watch-cli.js') writeFileSync(join(payloadDir, 'dist', 'watch-cli.js'), '// watch\n')
    writeFileSync(join(payloadDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'native\n')
    const manifestArgs = [
      PAYLOAD_CLI,
      'manifest',
      '--root', payloadDir,
      '--product', opts.product ?? 'agent-inbox-runtime',
      '--package-version', opts.packageVersion ?? version,
      '--source-commit', 'deadbeef',
      '--platform', 'darwin',
      '--arch', 'arm64',
      '--node-version', opts.nodeVersion ?? process.version,
      '--node-modules-abi', opts.nodeModulesAbi ?? process.versions.modules,
    ]
    for (const entrypoint of ['dist/mcp-server.js', 'dist/hook-cli.js', 'dist/watch-cli.js']) {
      if (entrypoint !== opts.omitEntrypoint && entrypoint !== opts.omitFile) {
        manifestArgs.push('--entrypoint', entrypoint)
      }
    }
    const manifest = JSON.parse(execFileSync(process.execPath, manifestArgs, { encoding: 'utf8' })) as { runtimeId: string }
    const runtimeId = manifest.runtimeId
    const manifestJson = readFileSync(join(payloadDir, 'runtime-manifest.json'), 'utf8')
    const digest = createHash('sha256').update(manifestJson).digest('hex')

    const setupInfoPath = join(bundleDir, 'setup-info.json')
    writeFileSync(setupInfoPath, JSON.stringify({
      schema: 2,
      version,
      builtAt: '2026-07-25T12:00:00.000Z',
      runtimePayloads: {
        'darwin-arm64': { path: 'runtime/darwin-arm64', digest: `sha256:${digest}` },
        'darwin-x64': { path: 'runtime/darwin-arm64', digest: `sha256:${'d'.repeat(64)}` },
      },
    }))
    return { setupInfoPath, runtimeRoot, digest, version, payloadDir, runtimeId }
  }

  const releaseStamp = async (): Promise<BuildStamp> => ({
    commit: null, builtAt: '2026-07-25T12:00:00.000Z', head: null, repoRoot: null, drift: 'release', version: '1.2.3',
  })

  const advancedHeaders = (): string[] =>
    [...document.querySelectorAll('#setup .setup-block h3')].map((h) => h.textContent ?? '')

  it('enables one-click install commands once the source payload verifies, but withholds manual MCP/hook commands until a runtime is installed', async () => {
    const { setupInfoPath, runtimeRoot, payloadDir, digest } = releaseBundle()
    await bootApp(open(), {
      viewer: { setupInfoPath, stamp: releaseStamp, runtimeHostKey: 'darwin-arm64', runtimeRoot },
    })
    await settle()

    const headers = advancedHeaders()
    expect(headers.some((h) => h.includes('Claude Code'))).toBe(false)
    expect(headers.some((h) => h.includes('Copilot MCP config'))).toBe(false)
    expect(headers.some((h) => h.includes('backstop hooks'))).toBe(false)
    // The shared-instructions snippet is not runtime-gated — it still renders.
    expect(headers.some((h) => h.includes('Manual shared instructions'))).toBe(true)

    expect(document.body.textContent).toContain('Run setup below to install')

    // The embedded-installer one-click commands ARE truthful and populated —
    // running them is what installs the runtime, so they don't wait for it.
    const agent = document.querySelector('.setup-agent-btn') as HTMLButtonElement
    const terminal = document.querySelector('.setup-command-btn') as HTMLButtonElement
    expect(agent.disabled).toBe(false)
    expect(terminal.disabled).toBe(false)
    const preview = document.querySelector('.setup-command-preview')?.textContent ?? ''
    expect(preview).toContain(payloadDir)
    expect(preview).toContain('--runtime-source')
    expect(preview).toContain(`sha256:${digest}`)
    expect(preview).toContain(join(payloadDir, 'scripts', 'install-agents.sh'))
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
    ['missing filesystem adapter', { omitFile: 'scripts/setup-filesystem.cjs' }],
  ])('withholds source and manual commands for %s', async (_label, override) => {
    const { setupInfoPath, runtimeRoot, payloadDir } = releaseBundle(override)
    await bootApp(open(), {
      viewer: { setupInfoPath, stamp: releaseStamp, runtimeHostKey: 'darwin-arm64', runtimeRoot },
    })
    await settle()

    expect((document.querySelector('.setup-agent-btn') as HTMLButtonElement).disabled).toBe(true)
    expect((document.querySelector('.setup-command-btn') as HTMLButtonElement).disabled).toBe(true)
    expect(document.body.textContent).not.toContain(payloadDir)
    const headers = advancedHeaders()
    expect(headers.some((h) => h.includes('Claude Code'))).toBe(false)
    expect(headers.some((h) => h.includes('Copilot MCP config'))).toBe(false)
  })

  it.each([
    ['installer bytes', (payloadDir: string) => writeFileSync(join(payloadDir, 'scripts', 'install-agents.sh'), '#!/bin/bash\necho tampered\n')],
    ['verifier helper bytes', (payloadDir: string) => writeFileSync(join(payloadDir, 'scripts', 'runtime-payload.mjs'), '// tampered\n')],
    ['native addon bytes', (payloadDir: string) => writeFileSync(join(payloadDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'tampered\n')],
    ['an extra file', (payloadDir: string) => writeFileSync(join(payloadDir, 'extra.js'), 'extra\n')],
    ['a mode change', (payloadDir: string) => chmodSync(join(payloadDir, 'scripts', 'install-agents.sh'), 0o755)],
    ['a manifest symlink', (payloadDir: string) => {
      const manifest = join(payloadDir, 'runtime-manifest.json')
      const outsideDir = mkdtempSync(join(tmpdir(), 'release-manifest-outside-'))
      dirs.push(outsideDir)
      const outside = join(outsideDir, 'runtime-manifest.json')
      writeFileSync(outside, readFileSync(manifest))
      rmSync(manifest)
      symlinkSync(outside, manifest)
    }],
  ])('withholds one-click commands when the source has %s', async (_label, tamper) => {
    const { setupInfoPath, runtimeRoot, payloadDir } = releaseBundle()
    tamper(payloadDir)
    await bootApp(open(), {
      viewer: { setupInfoPath, stamp: releaseStamp, runtimeHostKey: 'darwin-arm64', runtimeRoot },
    })
    await settle()

    expect((document.querySelector('.setup-agent-btn') as HTMLButtonElement).disabled).toBe(true)
    expect((document.querySelector('.setup-command-btn') as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('.setup-command-preview')?.textContent).toMatch(/not available yet/)
    expect(document.body.textContent).not.toContain(payloadDir)
  })

  it('exposes valid direct commands and enables copy actions once the exact installed runtime validates', async () => {
    const { setupInfoPath, runtimeRoot, payloadDir, runtimeId } = releaseBundle()
    // Install: copy the whole verified payload tree into runtimeRoot/<runtimeId>,
    // exactly as scripts/runtime-payload.mjs's installRuntime() does — the
    // installed manifest is therefore byte-identical to the source manifest.
    const dir = join(runtimeRoot, runtimeId)
    cpSync(payloadDir, dir, { recursive: true })

    await bootApp(open(), {
      viewer: { setupInfoPath, stamp: releaseStamp, runtimeHostKey: 'darwin-arm64', runtimeRoot },
    })
    await settle()

    const headers = advancedHeaders()
    expect(headers.some((h) => h.includes('Claude Code'))).toBe(true)
    expect(headers.some((h) => h.includes('Copilot MCP config'))).toBe(true)
    expect(headers.some((h) => h.includes('backstop hooks'))).toBe(true)
    expect(document.body.textContent).not.toContain('has not been installed yet')

    const claudeBlockText = [...document.querySelectorAll('#setup .setup-block')]
      .find((b) => b.querySelector('h3')?.textContent?.includes('Claude Code'))?.textContent ?? ''
    expect(claudeBlockText).toContain('claude mcp add')
    expect(claudeBlockText).toContain(join(dir, 'bin', 'node'))
    expect(claudeBlockText).toContain(join(dir, 'dist', 'mcp-server.js'))
  })

  it('withholds manual commands when an installed manifested file is tampered', async () => {
    const { setupInfoPath, runtimeRoot, payloadDir, runtimeId } = releaseBundle()
    const dir = join(runtimeRoot, runtimeId)
    cpSync(payloadDir, dir, { recursive: true })
    writeFileSync(join(dir, 'dist', 'mcp-server.js'), '// tampered installed mcp\n')

    await bootApp(open(), {
      viewer: { setupInfoPath, stamp: releaseStamp, runtimeHostKey: 'darwin-arm64', runtimeRoot },
    })
    await settle()

    const headers = advancedHeaders()
    expect(headers.some((h) => h.includes('Claude Code'))).toBe(false)
    expect(headers.some((h) => h.includes('Copilot MCP config'))).toBe(false)
    expect(headers.some((h) => h.includes('backstop hooks'))).toBe(false)
  })

  it('rejects a supplied but empty sha256 digest instead of treating it as unbound', async () => {
    const { setupInfoPath, runtimeRoot, payloadDir, runtimeId } = releaseBundle()
    cpSync(payloadDir, join(runtimeRoot, runtimeId), { recursive: true })
    const info = JSON.parse(readFileSync(setupInfoPath, 'utf8')) as {
      runtimePayloads: Record<string, { path: string; digest: string }>
    }
    info.runtimePayloads['darwin-arm64']!.digest = 'sha256:'
    writeFileSync(setupInfoPath, JSON.stringify(info))

    await bootApp(open(), {
      viewer: { setupInfoPath, stamp: releaseStamp, runtimeHostKey: 'darwin-arm64', runtimeRoot },
    })
    await settle()

    const headers = advancedHeaders()
    expect(headers.some((h) => h.includes('Claude Code'))).toBe(false)
    expect(headers.some((h) => h.includes('Copilot MCP config'))).toBe(false)
    expect((document.querySelector('.setup-command-btn') as HTMLButtonElement).disabled).toBe(true)
  })

  it('never trusts or renders an unverifiable runtime-source path — missing manifest, corrupt payload, or no runtime installed', async () => {
    // A bundle whose darwin-arm64 payload directory exists but has no
    // runtime-manifest.json at all — a corrupt/incomplete download, not a
    // dev/legacy bundle. The source must not verify, and nothing about that
    // directory may leak into a "success-shaped" command.
    const bundleDir = mkdtempSync(join(tmpdir(), 'release-bundle-broken-'))
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'release-runtime-root-broken-'))
    dirs.push(bundleDir, runtimeRoot)
    const payloadDir = join(bundleDir, 'runtime', 'darwin-arm64')
    mkdirSync(join(payloadDir, 'scripts'), { recursive: true })
    writeFileSync(join(payloadDir, 'scripts', 'install-agents.sh'), '#!/bin/bash\necho noop\n')
    // No runtime-manifest.json staged — the digest below is fabricated and
    // can never be verified against real bytes.
    const setupInfoPath = join(bundleDir, 'setup-info.json')
    writeFileSync(setupInfoPath, JSON.stringify({
      schema: 2,
      version: '1.2.3',
      builtAt: '2026-07-25T12:00:00.000Z',
      runtimePayloads: {
        'darwin-arm64': { path: 'runtime/darwin-arm64', digest: `sha256:${'0'.repeat(64)}` },
        'darwin-x64': { path: 'runtime/darwin-arm64', digest: `sha256:${'d'.repeat(64)}` },
      },
    }))

    await bootApp(open(), {
      viewer: { setupInfoPath, stamp: releaseStamp, runtimeHostKey: 'darwin-arm64', runtimeRoot },
    })
    await settle()

    const agent = document.querySelector('.setup-agent-btn') as HTMLButtonElement
    const terminal = document.querySelector('.setup-command-btn') as HTMLButtonElement
    expect(agent.disabled).toBe(true)
    expect(terminal.disabled).toBe(true)
    expect(document.querySelector('.setup-command-preview')?.textContent).toMatch(/not available yet/)
    expect(document.body.textContent).not.toContain(payloadDir)
    expect(document.body.textContent).not.toContain(runtimeRoot)

    const headers = advancedHeaders()
    expect(headers.some((h) => h.includes('Claude Code'))).toBe(false)
    expect(headers.some((h) => h.includes('Copilot MCP config'))).toBe(false)
    expect(headers.some((h) => h.includes('backstop hooks'))).toBe(false)
  })
})
