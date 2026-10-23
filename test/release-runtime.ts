// test/release-runtime.ts — a release bundle with a real, verifiable agent
// runtime payload for one host, shared by the viewer and DOM tests of #197.
//
// Deliberately NOT named *.test.ts: it is imported, never collected.
//
// The payload has the exact shape scripts/runtime-payload.mjs manifests and
// electron/runtime-verify.cjs verifies, so the viewer's own Setup lookups
// (installedRuntime / resolveReleaseRuntimeSource) run unmodified against it.
// `install()` copies it to runtimeRoot/<runtimeId> exactly as the installer
// does, which keeps the installed manifest byte-identical to the source one.
// Part 2 adds a scratch home: `register()`/`registerHooks()` write the same
// ~/.claude.json, ~/.copilot/mcp-config.json and ~/.claude/settings.json
// shapes the installers write, so the viewer reads host registrations from it
// and never from the real home directory.
//
// Paths resolve through node:path, never `new URL(…, import.meta.url)`: jsdom
// test files run in Vite's web transform mode (see test/dom/harness.ts).
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { scratchDir } from './scratch.js'

const PAYLOAD_CLI = resolve(import.meta.dirname, '..', 'scripts', 'runtime-payload.mjs')
const HOST = 'darwin-arm64'

export type AgentHost = 'claude' | 'copilot'

export interface ReleaseRuntime {
  /** createViewer options that point a viewer at this bundle, runtime root and
   *  scratch home (whose host config files stand in for ~/.claude.json etc.) */
  viewer: { setupInfoPath: string; runtimeRoot: string; runtimeHostKey: string; appRoot: string; agentHome: string }
  payloadDir: string
  runtimeRoot: string
  runtimeId: string
  /** the scratch home the viewer reads host registrations from */
  home: string
  /** install the payload as the agent runtime for this host */
  install(): string
  /** install a real, verifiable runtime of another version beside it */
  installVersion(version: string): string
  /** register a host's agent-inbox MCP server to run from a runtime or checkout directory */
  register(host: AgentHost, dir: string): void
  /** point Claude's backstop hooks at a runtime or checkout directory */
  registerHooks(dir: string): void
}

/** Write a runtime payload with the exact shape the installer manifests, and manifest it. */
function writePayload(payloadDir: string, version: string, opts: PayloadOptions = {}): string {
  const files: Record<string, string> = {
    'bin/node': '#!/bin/sh\n',
    'dist/mcp-server.js': '// mcp\n',
    'dist/hook-cli.js': '// hook\n',
    'dist/watch-cli.js': '// watch\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'native\n',
    'scripts/install-agents.sh': '#!/bin/bash\necho noop\n',
    'scripts/install-hooks.sh': '#!/bin/bash\necho noop\n',
    'scripts/prune-runtimes.sh': '#!/bin/bash\necho noop\n',
    'scripts/runtime-payload.mjs': '// helper\n',
    'scripts/runtime-config.mjs': '// config helper\n',
    'scripts/setup-filesystem.cjs': '// filesystem adapter\n',
    'scripts/setup-lock.sh': '# shared setup lock\n',
    'scripts/run-isolated.mjs': '// rollback step isolation\n',
  }
  for (const [path, content] of Object.entries(files)) {
    if (opts.omitFiles?.includes(path)) continue
    mkdirSync(join(payloadDir, path, '..'), { recursive: true })
    writeFileSync(join(payloadDir, path), content)
  }
  const manifest = JSON.parse(execFileSync(process.execPath, [
    PAYLOAD_CLI, 'manifest',
    '--root', payloadDir,
    '--product', opts.product ?? 'agent-inbox-runtime',
    '--package-version', version,
    '--source-commit', 'deadbeef',
    '--platform', 'darwin',
    '--arch', 'arm64',
    '--node-version', opts.nodeVersion ?? process.version,
    '--node-modules-abi', opts.nodeModulesAbi ?? process.versions.modules,
    '--entrypoint', 'dist/mcp-server.js',
    '--entrypoint', 'dist/hook-cli.js',
    '--entrypoint', 'dist/watch-cli.js',
  ], { encoding: 'utf8' })) as { runtimeId: string }
  return manifest.runtimeId
}

/** How a runtime from another build may differ from this app's own payload. */
export interface PayloadOptions {
  product?: string
  nodeVersion?: string
  nodeModulesAbi?: string
  omitFiles?: string[]
}

/** Install a real, verifiable runtime of `version` under `runtimeRoot`, exactly as the installer lays it out. */
export function installRuntimeVersion(runtimeRoot: string, version: string, opts: PayloadOptions = {}): string {
  const scratch = scratchDir('release-staged-')
  try {
    const staged = join(scratch, 'payload')
    const runtimeId = writePayload(staged, version, opts)
    const dir = join(runtimeRoot, runtimeId)
    cpSync(staged, dir, { recursive: true })
    return dir
  } finally {
    // only the installed copy is used: the staging folder never outlives this call (#240)
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Register (or replace) the agent-inbox MCP server in a host's config under `home`, keeping every other server. */
export function registerHost(home: string, host: AgentHost, command: string, entry: string): void {
  const file = host === 'claude' ? join(home, '.claude.json') : join(home, '.copilot', 'mcp-config.json')
  mkdirSync(dirname(file), { recursive: true })
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {}
  const servers = (config['mcpServers'] ?? {}) as Record<string, unknown>
  config['mcpServers'] = { ...servers, 'agent-inbox': { command, args: [entry] } }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
}

export function releaseRuntime(version: string, opts: { hostPayload?: boolean; pruneScript?: boolean } = {}): ReleaseRuntime {
  const appRoot = scratchDir('release-bundle-')
  const home = scratchDir('release-home-')
  const runtimeRoot = join(home, 'runtime')
  const payloadDir = join(appRoot, 'runtime', HOST)
  // a payload from before #294 carries no prune script
  const runtimeId = writePayload(payloadDir, version, opts.pruneScript === false ? { omitFiles: ['scripts/prune-runtimes.sh'] } : {})
  const digest = createHash('sha256').update(readFileSync(join(payloadDir, 'runtime-manifest.json'))).digest('hex')
  const setupInfoPath = join(appRoot, 'setup-info.json')
  writeFileSync(setupInfoPath, JSON.stringify({
    schema: 2,
    version,
    builtAt: '2026-10-17T12:00:00.000Z',
    runtimePayloads: opts.hostPayload === false
      ? {}
      : { [HOST]: { path: `runtime/${HOST}`, digest: `sha256:${digest}` } },
  }))
  return {
    viewer: { setupInfoPath, runtimeRoot, runtimeHostKey: HOST, appRoot, agentHome: home },
    payloadDir,
    runtimeRoot,
    runtimeId,
    home,
    install() {
      const dir = join(runtimeRoot, runtimeId)
      cpSync(payloadDir, dir, { recursive: true })
      return dir
    },
    installVersion(other: string) {
      return installRuntimeVersion(runtimeRoot, other)
    },
    register(host: AgentHost, dir: string) {
      registerHost(home, host, join(dir, 'bin', 'node'), join(dir, 'dist', 'mcp-server.js'))
    },
    registerHooks(dir: string) {
      const file = join(home, '.claude', 'settings.json')
      mkdirSync(dirname(file), { recursive: true })
      const hook = (sub: string) => ({ type: 'command', command: join(dir, 'bin', 'node'), args: [join(dir, 'dist', 'hook-cli.js'), sub], timeout: 5 })
      writeFileSync(file, `${JSON.stringify({
        hooks: {
          Notification: [{ hooks: [hook('notification')] }],
          Stop: [{ hooks: [hook('stop'), hook('watch')] }],
        },
      }, null, 2)}\n`)
    },
  }
}
