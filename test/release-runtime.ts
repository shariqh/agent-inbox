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
//
// Paths resolve through node:path, never `new URL(…, import.meta.url)`: jsdom
// test files run in Vite's web transform mode (see test/dom/harness.ts).
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PAYLOAD_CLI = resolve(import.meta.dirname, '..', 'scripts', 'runtime-payload.mjs')
const HOST = 'darwin-arm64'

export interface ReleaseRuntime {
  /** createViewer options that point a viewer at this bundle and runtime root */
  viewer: { setupInfoPath: string; runtimeRoot: string; runtimeHostKey: string; appRoot: string }
  payloadDir: string
  runtimeRoot: string
  runtimeId: string
  /** install the payload as the agent runtime for this host */
  install(): string
}

export function releaseRuntime(version: string, opts: { hostPayload?: boolean } = {}): ReleaseRuntime {
  const appRoot = mkdtempSync(join(tmpdir(), 'release-bundle-'))
  const runtimeRoot = join(mkdtempSync(join(tmpdir(), 'release-home-')), 'runtime')
  const payloadDir = join(appRoot, 'runtime', HOST)
  const files: Record<string, string> = {
    'bin/node': '#!/bin/sh\n',
    'dist/mcp-server.js': '// mcp\n',
    'dist/hook-cli.js': '// hook\n',
    'dist/watch-cli.js': '// watch\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'native\n',
    'scripts/install-agents.sh': '#!/bin/bash\necho noop\n',
    'scripts/runtime-payload.mjs': '// helper\n',
    'scripts/runtime-config.mjs': '// config helper\n',
    'scripts/setup-filesystem.cjs': '// filesystem adapter\n',
    'scripts/setup-lock.sh': '# shared setup lock\n',
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(payloadDir, path, '..'), { recursive: true })
    writeFileSync(join(payloadDir, path), content)
  }
  const manifest = JSON.parse(execFileSync(process.execPath, [
    PAYLOAD_CLI, 'manifest',
    '--root', payloadDir,
    '--product', 'agent-inbox-runtime',
    '--package-version', version,
    '--source-commit', 'deadbeef',
    '--platform', 'darwin',
    '--arch', 'arm64',
    '--node-version', process.version,
    '--node-modules-abi', process.versions.modules,
    '--entrypoint', 'dist/mcp-server.js',
    '--entrypoint', 'dist/hook-cli.js',
    '--entrypoint', 'dist/watch-cli.js',
  ], { encoding: 'utf8' })) as { runtimeId: string }
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
    viewer: { setupInfoPath, runtimeRoot, runtimeHostKey: HOST, appRoot },
    payloadDir,
    runtimeRoot,
    runtimeId: manifest.runtimeId,
    install() {
      const dir = join(runtimeRoot, manifest.runtimeId)
      cpSync(payloadDir, dir, { recursive: true })
      return dir
    },
  }
}
