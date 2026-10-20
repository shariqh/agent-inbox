import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAgentHosts, registeredRuntimeVersion } from '../src/agent-hosts.js'
import type { RuntimeVerifier } from '../src/agent-hosts.js'

const REPO = resolve(import.meta.dirname, '..')
const PAYLOAD_CLI = join(REPO, 'scripts', 'runtime-payload.mjs')
const { verifyRuntimePayload } = createRequire(import.meta.url)('../electron/runtime-verify.cjs') as {
  verifyRuntimePayload: RuntimeVerifier
}

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
    'run-isolated.mjs',
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

/** A source checkout of this repo: package.json named agent-inbox, a built dist/ and the real hook installer. */
function sourceCheckout(): string {
  const root = temp('agent-checkout-')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-inbox', version: '1.3.2' }))
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist', 'hook-cli.js'), "if (process.argv[2] === 'selftest') process.stdout.write('ok\\n')\n")
  for (const script of ['install-hooks.sh', 'setup-lock.sh', 'runtime-config.mjs', 'runtime-payload.mjs', 'setup-filesystem.cjs']) {
    copy(join(REPO, 'scripts', script), join(root, 'scripts', script))
  }
  return root
}

interface Fixture {
  home: string
  fakebin: string
  runtimeRoot: string
  env: NodeJS.ProcessEnv
  claudeConfig: string
  copilotConfig: string
  // The installer's TMPDIR, so its private work directory can be inspected.
  tmp: string
}

function fixture(): Fixture {
  const home = temp('agent-runtime-home-')
  const fakebin = join(home, 'fakebin')
  const runtimeRoot = join(home, '.agent-inbox', 'runtime')
  const tmp = join(home, 'tmp')
  mkdirSync(fakebin, { recursive: true })
  mkdirSync(tmp)
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
    test "\${FAIL_ADD:-}" != "$name" || exit 9
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
    tmp,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: tmp,
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
    // A committed install keeps no private work directory behind.
    expect(readdirSync(f.tmp).filter((name) => name.startsWith('agent-inbox-install.'))).toEqual([])

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

  // #197 part 2: Setup's Agents block reads back exactly what the installer
  // wrote, host by host — and "Update agents" for one host moves only that one.
  it('reads back each host\'s installed runtime and version as Setup reports them', () => {
    const f = fixture()
    const first = runtimePayload('1.0.0')
    expect(install(f, first).status).toBe(0)
    const second = runtimePayload('1.1.0')
    const updated = install(f, second, ['--target', 'claude'])
    expect(updated.status, updated.stderr).toBe(0)

    const hosts = readAgentHosts({
      home: f.home,
      runtimeRoot: f.runtimeRoot,
      checkRuntime: (dir, runtimeId) => registeredRuntimeVersion(dir, runtimeId, verifyRuntimePayload),
    })
    expect(hosts.claude).toEqual({ kind: 'runtime', version: '1.1.0', runtimeId: second.runtimeId })
    expect(hosts.copilot).toEqual({ kind: 'runtime', version: '1.0.0', runtimeId: first.runtimeId })
    expect(hosts.hooks).toEqual({ kind: 'none' })

    // hooks installed from the older runtime stay there until the command Setup
    // hands over — install-hooks.sh from the newer runtime — moves them
    const hooksFrom = (runtimeId: string) => spawnSync('/bin/bash', [
      join(f.runtimeRoot, runtimeId, 'scripts', 'install-hooks.sh'), '--apply',
    ], { encoding: 'utf8', env: f.env })
    const readHooks = () => readAgentHosts({
      home: f.home,
      runtimeRoot: f.runtimeRoot,
      checkRuntime: (dir, runtimeId) => registeredRuntimeVersion(dir, runtimeId, verifyRuntimePayload),
    }).hooks
    expect(hooksFrom(first.runtimeId).status).toBe(0)
    expect(readHooks()).toEqual({ kind: 'runtime', version: '1.0.0', runtimeId: first.runtimeId })
    const moved = hooksFrom(second.runtimeId)
    expect(moved.status, moved.stderr).toBe(0)
    expect(readHooks()).toEqual({ kind: 'runtime', version: '1.1.0', runtimeId: second.runtimeId })
  })

  // "Match agents to vX" after an app downgrade runs the same fixed install
  // with the OLDER bundled payload: the installer replaces the registration it
  // owns whichever way the version moves.
  it('matches a host on a newer runtime back to an older payload, leaving the other host alone', () => {
    const f = fixture()
    const newer = runtimePayload('1.1.0')
    expect(install(f, newer).status).toBe(0)
    const older = runtimePayload('1.0.0')
    const matched = install(f, older, ['--target', 'copilot'])
    expect(matched.status, matched.stderr).toBe(0)

    const hosts = readAgentHosts({
      home: f.home,
      runtimeRoot: f.runtimeRoot,
      checkRuntime: (dir, runtimeId) => registeredRuntimeVersion(dir, runtimeId, verifyRuntimePayload),
    })
    expect(hosts.copilot).toEqual({ kind: 'runtime', version: '1.0.0', runtimeId: older.runtimeId })
    expect(hosts.claude).toEqual({ kind: 'runtime', version: '1.1.0', runtimeId: newer.runtimeId })
  })

  // #218: switching Claude's hooks between a Setup runtime and a source
  // checkout, either way, never leaves two Agent Inbox sets. Each installer
  // refuses beside the other's set, printing the one-step replace first and
  // then the other's own uninstall when that can succeed; both work, and the
  // first works even when both sets are already there.
  it('switches Claude hooks between a Setup runtime and a checkout in both directions, never holding two sets', () => {
    const f = fixture()
    const payload = runtimePayload('1.2.4')
    expect(install(f, payload).status).toBe(0)
    const runtime = join(f.runtimeRoot, payload.runtimeId)
    const checkout = sourceCheckout()
    const settings = join(f.home, '.claude', 'settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    const otherTool = [{ hooks: [{ type: 'command', command: 'echo hi' }] }]
    writeFileSync(settings, JSON.stringify({ model: 'x', hooks: { PostToolUse: otherTool } }))

    // a checkout install takes jq and a Node 24 from the user's own PATH
    const checkoutEnv = { ...f.env, PATH: `${f.fakebin}:${process.env.PATH}`, AGENT_INBOX_NODE: process.execPath }
    const runtimeInstaller = join(runtime, 'scripts', 'install-hooks.sh')
    const checkoutInstaller = join(checkout, 'scripts', 'install-hooks.sh')
    const fromRuntime = (...flags: string[]) => spawnSync('/bin/bash', [runtimeInstaller, ...flags], { encoding: 'utf8', env: f.env })
    const fromCheckout = (...flags: string[]) => spawnSync('/bin/bash', [checkoutInstaller, ...flags], { encoding: 'utf8', env: checkoutEnv })
    const shell = (command: string, env: NodeJS.ProcessEnv) => spawnSync('/bin/bash', ['-c', command], { encoding: 'utf8', env })
    const runtimeEntry = join(runtime, 'dist', 'hook-cli.js')
    const checkoutEntry = join(checkout, 'dist', 'hook-cli.js')
    const expectOnly = (entry: string, step: string) => {
      const s = JSON.parse(readFileSync(settings, 'utf8')) as {
        model: string
        hooks: Record<string, Array<{ hooks: Array<{ args?: string[] }> }>>
      }
      expect(s.model, step).toBe('x')
      expect(s.hooks.PostToolUse, step).toEqual(otherTool)
      const entries = Object.values(s.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.args?.[0])))
        .filter((arg) => arg === runtimeEntry || arg === checkoutEntry)
      expect(entries, step).toEqual(Array(6).fill(entry))
    }

    const first = fromRuntime('--apply')
    expect(first.status, first.stderr).toBe(0)
    expectOnly(runtimeEntry, 'runtime installed')

    // every refusal recommends the one-step replace first, then offers each
    // other install's own uninstall only when it can succeed right now
    const printed = (stderr: string): string[] => [...stderr.matchAll(/bash '(?:[^']|'\\'')*'(?: --[a-z-]+)+/g)].map((m) => m[0])
    const replaceFromRuntime = `bash '${runtimeInstaller}' --apply --replace-existing`
    const replaceFromCheckout = `bash '${checkoutInstaller}' --apply --replace-existing`
    const removeRuntime = `bash '${runtimeInstaller}' --apply --uninstall`
    const removeCheckout = `bash '${checkoutInstaller}' --apply --uninstall`

    // runtime → checkout, in two steps through the alternative
    let refused = fromCheckout('--apply')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(`the v1.2.4 Setup runtime at ${runtime} (6 hooks)`)
    expect(printed(refused.stderr)).toEqual([replaceFromCheckout, removeRuntime])
    expectOnly(runtimeEntry, 'checkout refused')
    let step = shell(removeRuntime, f.env)
    expect(step.status, step.stderr).toBe(0)
    step = fromCheckout('--apply')
    expect(step.status, step.stderr).toBe(0)
    expectOnly(checkoutEntry, 'moved to the checkout')

    // checkout → runtime, the same from the runtime's side
    refused = fromRuntime('--apply')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(`the source checkout at ${checkout} (6 hooks)`)
    expect(printed(refused.stderr)).toEqual([replaceFromRuntime, removeCheckout])
    expectOnly(checkoutEntry, 'runtime refused')
    step = shell(removeCheckout, checkoutEnv)
    expect(step.status, step.stderr).toBe(0)
    step = fromRuntime('--apply')
    expect(step.status, step.stderr).toBe(0)
    expectOnly(runtimeEntry, 'moved back to the runtime')

    // and each way in one step, by running the first command a refusal prints
    step = shell(printed(fromCheckout('--apply').stderr)[0]!, checkoutEnv)
    expect(step.status, step.stderr).toBe(0)
    expectOnly(checkoutEntry, 'replaced by the checkout')
    step = shell(printed(fromRuntime('--apply').stderr)[0]!, f.env)
    expect(step.status, step.stderr).toBe(0)
    expectOnly(runtimeEntry, 'replaced by the runtime')

    // two sets at once, as this bug left them: the first printed command works from either side
    const doubled = () => {
      const s = JSON.parse(readFileSync(settings, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; args: string[] }> }>> }
      for (const [event, groups] of Object.entries(s.hooks)) {
        if (event === 'PostToolUse') continue
        s.hooks[event] = [...groups, ...groups.map((g) => ({ ...g, hooks: g.hooks.map((h) => ({ ...h, command: process.execPath, args: [checkoutEntry, h.args[1]!] })) }))]
      }
      writeFileSync(settings, JSON.stringify(s))
    }
    doubled()
    refused = fromCheckout('--apply')
    expect(printed(refused.stderr)).toEqual([replaceFromCheckout])
    step = shell(printed(refused.stderr)[0]!, checkoutEnv)
    expect(step.status, step.stderr).toBe(0)
    expectOnly(checkoutEntry, 'doubled, fixed from the checkout')
    expect(fromRuntime('--apply', '--replace-existing').status).toBe(0)
    doubled()
    refused = fromRuntime('--apply', '--uninstall')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(`the source checkout at ${checkout} (6 hooks)`)
    expect(printed(refused.stderr)).toEqual([replaceFromRuntime, removeCheckout])
    refused = fromRuntime('--apply')
    step = shell(printed(refused.stderr)[0]!, f.env)
    expect(step.status, step.stderr).toBe(0)
    expectOnly(runtimeEntry, 'doubled, fixed from the runtime')
  })

  // #232, as reported: a verified runtime copied to ~/Downloads, with its six
  // hooks in settings.json, was taken for another tool's, so a checkout install
  // exited 0 with twelve Agent Inbox hooks. The same happened to a Setup
  // runtime once AGENT_INBOX_RUNTIME_ROOT named another folder.
  it('never adds a second set beside the hooks of a runtime outside the runtime root', () => {
    const f = fixture()
    const payload = runtimePayload('1.2.4')
    const copied = join(f.home, 'Downloads', 'agent-inbox-1.2.4')
    cpSync(payload.root, copied, { recursive: true })
    const checkout = sourceCheckout()
    const settings = join(f.home, '.claude', 'settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    const otherTool = [{ hooks: [{ type: 'command', command: 'echo hi' }] }]
    writeFileSync(settings, JSON.stringify({ model: 'x', hooks: { PostToolUse: otherTool } }))

    const checkoutEnv = { ...f.env, PATH: `${f.fakebin}:${process.env.PATH}`, AGENT_INBOX_NODE: process.execPath }
    const run = (installer: string, env: NodeJS.ProcessEnv, ...flags: string[]) =>
      spawnSync('/bin/bash', [installer, ...flags], { encoding: 'utf8', env })
    const copiedInstaller = join(copied, 'scripts', 'install-hooks.sh')
    const checkoutInstaller = join(checkout, 'scripts', 'install-hooks.sh')
    const copiedEntry = join(copied, 'dist', 'hook-cli.js')
    const checkoutEntry = join(checkout, 'dist', 'hook-cli.js')
    const entries = (step: string): Array<string | undefined> => {
      const s = JSON.parse(readFileSync(settings, 'utf8')) as {
        model: string
        hooks?: Record<string, Array<{ hooks: Array<{ args?: string[] }> }>>
      }
      expect(s.model, step).toBe('x')
      expect(s.hooks?.PostToolUse, step).toEqual(otherTool)
      return Object.values(s.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.args?.[0])))
        .filter((arg) => arg !== undefined)
    }
    const outside = (dir: string) => `the v1.2.4 runtime at ${dir}, outside Setup's runtime folder (6 hooks)`

    // the copy's own installer adds its six hooks, and re-installs over them
    for (const step of ['copy installed', 'copy re-installed']) {
      const own = run(copiedInstaller, f.env, '--apply')
      expect(own.status, own.stderr).toBe(0)
      expect(entries(step), step).toEqual(Array(6).fill(copiedEntry))
    }

    // the reported step, from a checkout
    let refused = run(checkoutInstaller, checkoutEnv, '--apply')
    expect(refused.status, refused.stderr).toBe(1)
    expect(refused.stderr).toContain(outside(copied))
    expect(entries('checkout refused'), 'checkout refused').toEqual(Array(6).fill(copiedEntry))
    let step = run(checkoutInstaller, checkoutEnv, '--apply', '--replace-existing')
    expect(step.status, step.stderr).toBe(0)
    expect(entries('replaced by the checkout'), 'replaced by the checkout').toEqual(Array(6).fill(checkoutEntry))

    // from a Setup runtime under the root
    expect(install(f, payload).status).toBe(0)
    const runtime = join(f.runtimeRoot, payload.runtimeId)
    const runtimeInstaller = join(runtime, 'scripts', 'install-hooks.sh')
    const runtimeEntry = join(runtime, 'dist', 'hook-cli.js')
    step = run(copiedInstaller, f.env, '--apply', '--replace-existing')
    expect(step.status, step.stderr).toBe(0)
    refused = run(runtimeInstaller, f.env, '--apply')
    expect(refused.status, refused.stderr).toBe(1)
    expect(refused.stderr).toContain(outside(copied))
    expect(entries('runtime refused'), 'runtime refused').toEqual(Array(6).fill(copiedEntry))
    step = run(runtimeInstaller, f.env, '--apply', '--replace-existing')
    expect(step.status, step.stderr).toBe(0)
    expect(entries('replaced by the runtime'), 'replaced by the runtime').toEqual(Array(6).fill(runtimeEntry))

    // that runtime's own hooks, once the runtime root is another folder
    const elsewhereEnv = { ...checkoutEnv, AGENT_INBOX_RUNTIME_ROOT: join(f.home, 'another-root') }
    refused = run(checkoutInstaller, elsewhereEnv, '--apply')
    expect(refused.status, refused.stderr).toBe(1)
    expect(refused.stderr).toContain(outside(runtime))
    step = run(checkoutInstaller, elsewhereEnv, '--apply', '--replace-existing')
    expect(step.status, step.stderr).toBe(0)
    expect(entries('replaced from another root'), 'replaced from another root').toEqual(Array(6).fill(checkoutEntry))

    // the copy's own uninstall removes exactly its own set
    step = run(copiedInstaller, f.env, '--apply', '--replace-existing')
    expect(step.status, step.stderr).toBe(0)
    step = run(copiedInstaller, f.env, '--apply', '--uninstall')
    expect(step.status, step.stderr).toBe(0)
    expect(entries('copy uninstalled'), 'copy uninstalled').toEqual([])
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

  it('writes packaged hooks through a symlinked settings.json without replacing the link', () => {
    const f = fixture()
    const payload = runtimePayload('1.0.0')
    expect(install(f, payload).status).toBe(0)
    const installed = join(f.runtimeRoot, payload.runtimeId)
    const script = join(installed, 'scripts', 'install-hooks.sh')
    const settings = join(f.home, '.claude', 'settings.json')
    const target = join(f.home, 'dotfiles', 'claude-settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '{"model":"x"}\n')
    symlinkSync(target, settings)

    const applied = spawnSync('/bin/bash', [script, '--apply'], { encoding: 'utf8', env: f.env })
    expect(applied.status, applied.stderr).toBe(0)
    expect(lstatSync(settings).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain(join(installed, 'dist', 'hook-cli.js'))

    const removed = spawnSync('/bin/bash', [script, '--apply', '--uninstall'], { encoding: 'utf8', env: f.env })
    expect(removed.status, removed.stderr).toBe(0)
    expect(lstatSync(settings).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ model: 'x' })
  })

  // #211: a prune renames the runtime under a reserved trash name before it
  // deletes anything, so killing it partway never leaves a half-deleted tree
  // under a valid runtime id.
  it('installs the same version again after a prune was killed partway through deleting it', () => {
    const f = fixture()
    const payload = runtimePayload('1.0.0')
    const helper = join(payload.root, 'scripts', 'runtime-payload.mjs')
    const installed = join(f.runtimeRoot, payload.runtimeId)
    const published = spawnSync(process.execPath, [
      helper, 'install', '--payload-root', payload.root, '--runtime-root', f.runtimeRoot,
    ], { encoding: 'utf8' })
    expect(published.status, published.stderr).toBe(0)

    // Deletes one file of the runtime being removed, then dies the way a
    // SIGKILLed prune does.
    const killer = join(f.home, 'kill-mid-delete.cjs')
    writeFileSync(killer, `
const fs = require('node:fs')
const { join } = require('node:path')
const remove = fs.rmSync
function firstFile(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile()) return path
    if (entry.isDirectory()) {
      const found = firstFile(path)
      if (found) return found
    }
  }
  return null
}
fs.rmSync = function rmSync(path, options) {
  if (options && options.recursive && String(path).includes('/.agent-inbox/runtime/')) {
    const victim = firstFile(String(path))
    if (victim) remove(victim)
    process.kill(process.pid, 'SIGKILL')
  }
  return remove.call(this, path, options)
}
`)
    const pruned = spawnSync(process.execPath, [
      '--require', killer, helper, 'prune', '--runtime-root', f.runtimeRoot, '--runtime-id', payload.runtimeId,
    ], { encoding: 'utf8' })
    expect(pruned.signal).toBe('SIGKILL')
    const trashAfterKill = readdirSync(f.runtimeRoot).filter((name) => name.startsWith('.trash-'))

    const result = install(f, payload)

    expect(result.status, result.stderr).toBe(0)
    expect(trashAfterKill, 'the interrupted prune left only a trash folder').toHaveLength(1)
    expect(registration(f.claudeConfig)?.command).toBe(join(installed, 'bin', 'node'))
    const verified = spawnSync(process.execPath, [PAYLOAD_CLI, 'verify', '--root', installed], { encoding: 'utf8' })
    expect(verified.status, verified.stderr).toBe(0)
    // The next install removed the leftover trash.
    expect(readdirSync(f.runtimeRoot).filter((name) => name.startsWith('.trash-'))).toEqual([])
  })

  it('never lists, collides with, or follows anything under a reserved trash name', () => {
    const f = fixture()
    const payload = runtimePayload('1.0.0')
    // A complete copy of this very runtime, and a link to a folder elsewhere,
    // both under trash names.
    mkdirSync(f.runtimeRoot, { recursive: true })
    cpSync(payload.root, join(f.runtimeRoot, `.trash-${payload.runtimeId}-copy`), { recursive: true })
    const outside = temp('agent-runtime-outside-')
    writeFileSync(join(outside, 'keep.txt'), 'keep\n')
    symlinkSync(outside, join(f.runtimeRoot, '.trash-link'))

    const listed = spawnSync(process.execPath, [PAYLOAD_CLI, 'list', '--runtime-root', f.runtimeRoot], { encoding: 'utf8' })
    expect(listed.status, listed.stderr).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual([])

    const result = install(f, payload)

    expect(result.status, result.stderr).toBe(0)
    const installed = join(f.runtimeRoot, payload.runtimeId)
    expect(registration(f.claudeConfig)?.command).toBe(join(installed, 'bin', 'node'))
    expect(readdirSync(f.runtimeRoot).filter((name) => name.startsWith('.trash-'))).toEqual([])
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep\n')
  })

  it('finishes the rollback\'s runtime reference check and prune through repeat signals to the installer (#211)', async () => {
    const f = fixture()
    const payload = runtimePayload('1.0.0')
    // Pauses the rollback's reference check until released, so the signals
    // provably land while it runs.
    const paused = join(f.home, 'references.paused')
    const released = join(f.home, 'references.release')
    const preload = join(f.home, 'pause-references.cjs')
    writeFileSync(preload, [
      "const fs = require('node:fs')",
      "if (/runtime-config\\.mjs$/.test(process.argv[1] || '') && process.argv[2] === 'references') {",
      `  fs.writeFileSync(${JSON.stringify(paused)}, String(process.pid))`,
      `  while (!fs.existsSync(${JSON.stringify(released)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)`,
      '}',
      '',
    ].join('\n'))
    // Claude registers, then Copilot's registration fails: the rollback
    // undoes Claude and must then remove the runtime it published.
    const env = { ...f.env, FAIL_ADD: 'copilot', NODE_OPTIONS: `--require ${preload}` }
    const installer = spawn('/bin/bash', [
      join(payload.root, 'scripts', 'install-agents.sh'),
      '--apply', '--runtime-source', payload.root, '--runtime-digest', payload.digest,
    ], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    installer.stdout!.resume()
    installer.stderr!.setEncoding('utf8')
    installer.stderr!.on('data', (chunk: string) => { stderr += chunk })
    const exited = new Promise<number | null>((resolveExit) => installer.once('close', (code) => resolveExit(code)))
    try {
      const deadline = Date.now() + 15_000
      while (!existsSync(paused)) {
        if (Date.now() > deadline) throw new Error('the rollback never reached its reference check')
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
      }
      // A second Ctrl-C and Setup's cancel reach the installer's whole group.
      process.kill(-installer.pid!, 'SIGINT')
      process.kill(-installer.pid!, 'SIGTERM')
      await new Promise((resolveWait) => setTimeout(resolveWait, 300))
      writeFileSync(released, '')
      expect(await exited).toBe(1)
    } finally {
      writeFileSync(released, '')
      try {
        process.kill(-installer.pid!, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }

    expect(stderr).toContain('removed unreferenced runtime after failed install')
    expect(stderr).not.toContain('retained newly installed runtime')
    expect(existsSync(join(f.runtimeRoot, payload.runtimeId))).toBe(false)
    expect(readdirSync(f.runtimeRoot)).toEqual([])
    expect(registration(f.claudeConfig)).toBeUndefined()
  }, 30_000)
})
