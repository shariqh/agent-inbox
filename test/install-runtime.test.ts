import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = resolve(import.meta.dirname, '..')
const PAYLOAD_CLI = join(REPO, 'scripts', 'runtime-payload.mjs')

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function copy(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
}

function runtimePayload(
  version: string,
  options: { committedFailure?: 'exact' | 'substituted' } = {},
): { root: string; digest: string; runtimeId: string } {
  const root = temp(`agent-runtime-${version}-`)
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`)
  chmodSync(join(root, 'bin', 'node'), 0o755)
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'mcp-server.js'), 'process.exit(0)\n')
  writeFileSync(
    join(root, 'dist', 'hook-cli.js'),
    "if (process.argv[2] === 'selftest') process.stdout.write('ok\\n')\n",
  )
  writeFileSync(join(root, 'dist', 'watch-cli.js'), 'process.exit(0)\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))

  for (const script of [
    'install-agents.sh',
    'install-hooks.sh',
    'runtime-payload.mjs',
    'runtime-config.mjs',
    'setup-filesystem.cjs',
    'setup-lock.sh',
  ]) {
    copy(join(REPO, 'scripts', script), join(root, 'scripts', script))
  }
  if (options.committedFailure) {
    const realHelper = join(root, 'scripts', 'runtime-payload-real.mjs')
    copy(join(REPO, 'scripts', 'runtime-payload.mjs'), realHelper)
    writeFileSync(join(root, 'scripts', 'runtime-payload.mjs'), `
export * from './runtime-payload-real.mjs'

import { spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = ${JSON.stringify(options.committedFailure)}
const scriptDir = dirname(fileURLToPath(import.meta.url))
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const result = spawnSync(process.execPath, [join(scriptDir, 'runtime-payload-real.mjs'), ...args], {
    stdio: 'inherit',
  })
  if (args[0] !== 'install' || result.status !== 0) process.exit(result.status ?? 1)

  if (mode === 'substituted') {
    const value = (name) => {
      const index = args.indexOf(name)
      return index >= 0 ? args[index + 1] : null
    }
    const payloadRoot = value('--payload-root')
    const runtimeRoot = value('--runtime-root')
    const manifest = JSON.parse(readFileSync(join(payloadRoot, 'runtime-manifest.json'), 'utf8'))
    const destination = join(runtimeRoot, manifest.runtimeId)
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, 'substituted.txt'), 'not the committed runtime\\n')
  }

  process.stderr.write('runtime-payload: committed install fixture\\n')
  process.exit(3)
}
`)
  }
  copy(join(REPO, 'docs', 'reporting-snippet.md'), join(root, 'docs', 'reporting-snippet.md'))
  copy(join(REPO, 'docs', 'hooks.md'), join(root, 'docs', 'hooks.md'))
  for (const host of ['claude-code.md', 'copilot-cli.md']) {
    copy(join(REPO, 'docs', 'instructions', host), join(root, 'docs', 'instructions', host))
  }

  const result = spawnSync(process.execPath, [
    PAYLOAD_CLI,
    'manifest',
    '--root', root,
    '--product', 'agent-inbox-runtime',
    '--package-version', version,
    '--source-commit', 'deadbeef',
    '--platform', process.platform,
    '--arch', process.arch,
    '--node-version', process.version,
    '--node-modules-abi', process.versions.modules,
    '--entrypoint', 'dist/mcp-server.js',
    '--entrypoint', 'dist/hook-cli.js',
    '--entrypoint', 'dist/watch-cli.js',
  ], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  const manifest = JSON.parse(result.stdout) as { runtimeId: string }
  const digest = createHash('sha256')
    .update(readFileSync(join(root, 'runtime-manifest.json')))
    .digest('hex')
  return { root, digest: `sha256:${digest}`, runtimeId: manifest.runtimeId }
}

interface Fixture {
  home: string
  fakebin: string
  runtimeRoot: string
  env: NodeJS.ProcessEnv
  claudeConfig: string
  copilotConfig: string
}

function fixture(): Fixture {
  const home = temp('agent-runtime-home-')
  const fakebin = join(home, 'fakebin')
  const runtimeRoot = join(home, '.agent-inbox', 'runtime')
  mkdirSync(fakebin, { recursive: true })
  const claudeConfig = join(home, '.claude.json')
  const copilotConfig = join(home, '.copilot', 'mcp-config.json')
  mkdirSync(dirname(copilotConfig), { recursive: true })
  writeFileSync(claudeConfig, '{"mcpServers":{}}\n')
  writeFileSync(copilotConfig, '{"mcpServers":{}}\n')

  const cli = `#!/bin/sh
name="$(basename "$0")"
if [ "$name" = claude ]; then config="$CLAUDE_CONFIG"; else config="$COPILOT_CONFIG"; fi
case "$1:$2" in
  mcp:get)
    "$TEST_NODE" -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit(p.mcpServers?.["agent-inbox"]?0:1)' "$config" || exit 1
    if [ "$name" = claude ]; then echo "Scope: User config"; else echo '{"source":"user"}'; fi
    ;;
  mcp:add)
    if [ "$name" = claude ]; then node="$7"; entry="$8"; else node="$5"; entry="$6"; fi
    "$TEST_NODE" -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));p.mcpServers??={};p.mcpServers["agent-inbox"]={command:process.argv[2],args:[process.argv[3]]};fs.writeFileSync(f,JSON.stringify(p)+"\\n")' "$config" "$node" "$entry"
    ;;
  mcp:remove)
    "$TEST_NODE" -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));if(p.mcpServers)delete p.mcpServers["agent-inbox"];fs.writeFileSync(f,JSON.stringify(p)+"\\n")' "$config"
    ;;
  *) exit 2 ;;
esac
`
  for (const name of ['claude', 'copilot']) {
    writeFileSync(join(fakebin, name), cli)
    chmodSync(join(fakebin, name), 0o755)
  }
  const lock = spawnSync('/bin/sh', ['-c', 'command -v lockf || command -v flock'], { encoding: 'utf8' }).stdout.trim()
  if (!lock) throw new Error('runtime installer tests require lockf or flock')
  symlinkSync(lock, join(fakebin, lock.slice(lock.lastIndexOf('/') + 1)))

  return {
    home,
    fakebin,
    runtimeRoot,
    claudeConfig,
    copilotConfig,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakebin}:/usr/bin:/bin`,
      TEST_NODE: process.execPath,
      CLAUDE_CONFIG: claudeConfig,
      COPILOT_CONFIG: copilotConfig,
      AGENT_INBOX_RUNTIME_ROOT: runtimeRoot,
    },
  }
}

function install(
  f: Fixture,
  payload: { root: string; digest: string },
  extra: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('/bin/bash', [
    join(payload.root, 'scripts', 'install-agents.sh'),
    '--apply',
    '--runtime-source', payload.root,
    '--runtime-digest', payload.digest,
    ...extra,
  ], { encoding: 'utf8', env: f.env })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function registration(path: string): { command: string; args: string[] } | undefined {
  return (JSON.parse(readFileSync(path, 'utf8')) as {
    mcpServers?: Record<string, { command: string; args: string[] }>
  }).mcpServers?.['agent-inbox']
}

describe('portable release installer', () => {
  it('rolls back a newly published exact runtime when the helper reports a committed failure', () => {
    const f = fixture()
    const payload = runtimePayload('1.0.0-committed', { committedFailure: 'exact' })
    const claudeBefore = readFileSync(f.claudeConfig, 'utf8')
    const copilotBefore = readFileSync(f.copilotConfig, 'utf8')

    const result = install(f, payload)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/committed install/i)
    expect(result.stderr).toMatch(/removed unreferenced runtime after failed install/i)
    expect(existsSync(join(f.runtimeRoot, payload.runtimeId))).toBe(false)
    expect(readFileSync(f.claudeConfig, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotConfig, 'utf8')).toBe(copilotBefore)
  })

  it('retains an unverified substituted destination after a committed failure', () => {
    const f = fixture()
    const payload = runtimePayload('1.0.0-substituted', { committedFailure: 'substituted' })
    const claudeBefore = readFileSync(f.claudeConfig, 'utf8')
    const copilotBefore = readFileSync(f.copilotConfig, 'utf8')
    const installed = join(f.runtimeRoot, payload.runtimeId)

    const result = install(f, payload)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/committed install/i)
    expect(result.stderr).toMatch(/could not verify the exact expected runtime/i)
    expect(readFileSync(join(installed, 'substituted.txt'), 'utf8')).toBe('not the committed runtime\n')
    expect(readFileSync(f.claudeConfig, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotConfig, 'utf8')).toBe(copilotBefore)
  })

  it('installs both hosts into a stable runtime that survives deleting the app payload', () => {
    const f = fixture()
    const payload = runtimePayload('1.0.0')
    const result = install(f, payload)
    expect(result.status, result.stderr).toBe(0)

    const installed = join(f.runtimeRoot, payload.runtimeId)
    for (const config of [f.claudeConfig, f.copilotConfig]) {
      expect(registration(config)).toEqual({
        command: join(installed, 'bin', 'node'),
        args: [join(installed, 'dist', 'mcp-server.js')],
      })
    }

    rmSync(payload.root, { recursive: true })
    const selftest = spawnSync(
      join(installed, 'bin', 'node'),
      [join(installed, 'dist', 'hook-cli.js'), 'selftest'],
      { encoding: 'utf8', env: f.env },
    )
    expect(selftest.status, selftest.stderr).toBe(0)

    const removed = spawnSync(
      '/bin/bash',
      [join(installed, 'scripts', 'install-agents.sh'), '--apply', '--uninstall'],
      { encoding: 'utf8', env: f.env },
    )
    expect(removed.status, removed.stderr).toBe(0)
    expect(registration(f.claudeConfig)).toBeUndefined()
    expect(registration(f.copilotConfig)).toBeUndefined()
    expect(existsSync(installed)).toBe(false)
  })

  it('refuses to replace or remove a checkout/custom registration', () => {
    const f = fixture()
    const payload = runtimePayload('1.0.0')
    const custom = { mcpServers: { 'agent-inbox': { command: process.execPath, args: ['/checkout/dist/mcp-server.js'] } } }
    writeFileSync(f.claudeConfig, `${JSON.stringify(custom)}\n`)

    const result = install(f, payload, ['--target', 'claude'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/refusing to replace or remove/)
    expect(JSON.parse(readFileSync(f.claudeConfig, 'utf8'))).toEqual(custom)
    expect(existsSync(join(f.runtimeRoot, payload.runtimeId))).toBe(false)
  })

  it('upgrades owned registrations and keeps only current plus one previous runtime', () => {
    const f = fixture()
    const payloads = ['1.0.0', '1.1.0', '1.2.0'].map((version) => runtimePayload(version))
    for (const payload of payloads) {
      const result = install(f, payload)
      expect(result.status, result.stderr).toBe(0)
    }

    const current = payloads[2]!
    expect(registration(f.claudeConfig)?.command).toBe(join(f.runtimeRoot, current.runtimeId, 'bin', 'node'))
    const runtimes = readdirSync(f.runtimeRoot).filter((name) => !name.startsWith('.'))
    expect(runtimes).toHaveLength(2)
    expect(runtimes).toContain(current.runtimeId)

    const currentDir = join(f.runtimeRoot, current.runtimeId)
    const removed = spawnSync(
      '/bin/bash',
      [join(currentDir, 'scripts', 'install-agents.sh'), '--apply', '--uninstall'],
      { encoding: 'utf8', env: f.env },
    )
    expect(removed.status, removed.stderr).toBe(0)
    expect(readdirSync(f.runtimeRoot).filter((name) => !name.startsWith('.'))).toEqual([])
  })

  it('installs and removes packaged hooks without ambient node or jq', () => {
    const f = fixture()
    const payload = runtimePayload('1.0.0')
    expect(install(f, payload).status).toBe(0)
    const installed = join(f.runtimeRoot, payload.runtimeId)
    const script = join(installed, 'scripts', 'install-hooks.sh')

    const applied = spawnSync('/bin/bash', [script, '--apply'], { encoding: 'utf8', env: f.env })
    expect(applied.status, applied.stderr).toBe(0)
    const settings = join(f.home, '.claude', 'settings.json')
    expect(readFileSync(settings, 'utf8')).toContain(join(installed, 'dist', 'hook-cli.js'))

    const removed = spawnSync('/bin/bash', [script, '--apply', '--uninstall'], { encoding: 'utf8', env: f.env })
    expect(removed.status, removed.stderr).toBe(0)
    expect(readFileSync(settings, 'utf8')).not.toContain('hook-cli.js')
  })
})
