// Issue #197, part 2 — which Agent Inbox build each host's agents are
// registered to run. Read-only, from the same host config files the installer
// manages: ~/.claude.json and ~/.copilot/mcp-config.json (`mcpServers`), plus
// the agent-inbox-shaped hook entries in ~/.claude/settings.json. Only the
// agent-inbox entry is ever read out; every other server stays in the file.
//
// A registration counts as Setup's runtime under exactly the rule the installer
// uses before it may replace one (scripts/runtime-config.mjs
// classifyRuntimeRegistration): node and entry both resolve, by real filesystem
// identity, into the same directory under the runtime root, and that directory
// is an intact runtime whose manifest names it. The last test runs the
// installer's own helper over the same files and holds the two to agreement.
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readAgentHosts, registeredRuntimeVersion } from '../src/agent-hosts.js'
import type { RuntimeVerifier } from '../src/agent-hosts.js'
import { installRuntimeVersion, registerHost } from './release-runtime.js'

const REPO = resolve(import.meta.dirname, '..')
const { verifyRuntimePayload } = createRequire(import.meta.url)('../electron/runtime-verify.cjs') as {
  verifyRuntimePayload: RuntimeVerifier
}

interface Scratch { home: string; runtimeRoot: string }
function scratch(): Scratch {
  const home = mkdtempSync(join(tmpdir(), 'agent-hosts-'))
  const runtimeRoot = join(home, '.agent-inbox', 'runtime')
  mkdirSync(runtimeRoot, { recursive: true })
  return { home, runtimeRoot }
}

function read(s: Scratch, verify: RuntimeVerifier = verifyRuntimePayload) {
  return readAgentHosts({
    home: s.home,
    runtimeRoot: s.runtimeRoot,
    checkRuntime: (dir, runtimeId) => registeredRuntimeVersion(dir, runtimeId, verify),
  })
}

/** A source checkout of this repo: package.json named agent-inbox, a built dist/. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-hosts-checkout-'))
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-inbox', version: '1.3.0' }))
  writeFileSync(join(root, 'dist', 'mcp-server.js'), '// mcp\n')
  writeFileSync(join(root, 'dist', 'hook-cli.js'), '// hook\n')
  return root
}

const configFile = (s: Scratch, host: 'claude' | 'copilot'): string =>
  host === 'claude' ? join(s.home, '.claude.json') : join(s.home, '.copilot', 'mcp-config.json')

function writeConfig(s: Scratch, host: 'claude' | 'copilot', body: string): void {
  const file = configFile(s, host)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, body)
}

function registerRuntime(s: Scratch, host: 'claude' | 'copilot', dir: string): void {
  registerHost(s.home, host, join(dir, 'bin', 'node'), join(dir, 'dist', 'mcp-server.js'))
}

function writeHooks(s: Scratch, launchers: Array<{ command: string; entry: string }>): void {
  mkdirSync(join(s.home, '.claude'), { recursive: true })
  writeFileSync(join(s.home, '.claude', 'settings.json'), JSON.stringify({
    model: 'opus',
    hooks: {
      // another tool's hook beside ours is never read as ours
      PreToolUse: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-tool', args: ['--audit'] }] }],
      Stop: [{ hooks: launchers.map((l, i) => ({ type: 'command', command: l.command, args: [l.entry, i % 2 ? 'watch' : 'stop'] })) }],
    },
  }))
}

describe('readAgentHosts (#197)', () => {
  it('reports no registration when a config file or its agent-inbox entry is absent', () => {
    const s = scratch()
    expect(read(s)).toEqual({ claude: { kind: 'none' }, copilot: { kind: 'none' }, hooks: { kind: 'none' } })

    writeConfig(s, 'claude', JSON.stringify({ mcpServers: { github: { command: '/usr/bin/gh', args: ['mcp'] } } }))
    writeConfig(s, 'copilot', '')
    mkdirSync(join(s.home, '.claude'), { recursive: true })
    writeFileSync(join(s.home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }))
    expect(read(s)).toEqual({ claude: { kind: 'none' }, copilot: { kind: 'none' }, hooks: { kind: 'none' } })
  })

  it('names the Setup runtime, by id and version, that each host is registered to run', () => {
    const s = scratch()
    const old = installRuntimeVersion(s.runtimeRoot, '1.2.8')
    const current = installRuntimeVersion(s.runtimeRoot, '1.3.0')
    registerRuntime(s, 'claude', old)
    registerRuntime(s, 'copilot', current)

    const hosts = read(s)
    expect(hosts.claude).toEqual({ kind: 'runtime', version: '1.2.8', runtimeId: old.slice(s.runtimeRoot.length + 1) })
    expect(hosts.copilot).toEqual({ kind: 'runtime', version: '1.3.0', runtimeId: current.slice(s.runtimeRoot.length + 1) })
  })

  it('owns a runtime by its own manifest, not by this app\'s Node ABI or newer required files', () => {
    const s = scratch()
    // a runtime from a build on another Node major, missing helpers a later
    // release requires: still an intact runtime of ours, so still Setup's
    const other = installRuntimeVersion(s.runtimeRoot, '1.1.0', {
      nodeVersion: 'v26.1.0', nodeModulesAbi: '147', omitFiles: ['scripts/setup-lock.sh', 'scripts/setup-filesystem.cjs'],
    })
    registerRuntime(s, 'claude', other)
    expect(read(s).claude).toMatchObject({ kind: 'runtime', version: '1.1.0' })
  })

  it('reports a source checkout by its path, and any other command as not managed by Setup', () => {
    const s = scratch()
    const root = checkout()
    registerHost(s.home, 'claude', process.execPath, join(root, 'dist', 'mcp-server.js'))
    const script = join(mkdtempSync(join(tmpdir(), 'agent-hosts-other-')), 'server.js')
    writeFileSync(script, '// someone else\'s build\n')
    registerHost(s.home, 'copilot', process.execPath, script)

    const hosts = read(s)
    expect(hosts.claude).toEqual({ kind: 'checkout', path: realpathSync(root) })
    expect(hosts.copilot).toEqual({ kind: 'other' })

    // the command is looked up on PATH and the entry is not a path: still not Setup's
    writeConfig(s, 'copilot', JSON.stringify({ mcpServers: { 'agent-inbox': { command: 'npx', args: ['tsx', 'src/mcp-server.ts'] } } }))
    expect(read(s).copilot).toEqual({ kind: 'other' })

    // a runtime outside the root is the registration installer's `custom`, which it never replaces
    registerRuntime(s, 'copilot', installRuntimeVersion(mkdtempSync(join(tmpdir(), 'agent-hosts-elsewhere-')), '1.2.8'))
    expect(read(s).copilot).toEqual({ kind: 'other' })
  })

  it('cannot verify a malformed entry, unreadable JSON, a split pair, a missing path or a tampered runtime', () => {
    const cases: Array<[string, (s: Scratch) => void]> = [
      ['invalid JSON', (s) => writeConfig(s, 'claude', '{"mcpServers": {')],
      ['a null entry', (s) => writeConfig(s, 'claude', JSON.stringify({ mcpServers: { 'agent-inbox': null } }))],
      ['no args', (s) => writeConfig(s, 'claude', JSON.stringify({ mcpServers: { 'agent-inbox': { command: process.execPath } } }))],
      ['a non-string entry', (s) => writeConfig(s, 'claude', JSON.stringify({ mcpServers: { 'agent-inbox': { command: process.execPath, args: [42] } } }))],
      ['node and entry in two places', (s) => {
        const dir = installRuntimeVersion(s.runtimeRoot, '1.2.8')
        registerHost(s.home, 'claude', join(dir, 'bin', 'node'), join(checkout(), 'dist', 'mcp-server.js'))
      }],
      ['a removed runtime', (s) => {
        registerHost(s.home, 'claude', join(s.runtimeRoot, 'gone', 'bin', 'node'), join(s.runtimeRoot, 'gone', 'dist', 'mcp-server.js'))
      }],
      ['a tampered runtime', (s) => {
        const dir = installRuntimeVersion(s.runtimeRoot, '1.2.8')
        registerRuntime(s, 'claude', dir)
        writeFileSync(join(dir, 'dist', 'mcp-server.js'), '// tampered\n')
      }],
    ]
    for (const [label, arrange] of cases) {
      const s = scratch()
      arrange(s)
      expect(read(s).claude, label).toEqual({ kind: 'unknown' })
    }
  })

  it('never returns another MCP server\'s command, arguments or environment', () => {
    const s = scratch()
    const dir = installRuntimeVersion(s.runtimeRoot, '1.2.8')
    const root = checkout()
    const secrets = { command: '/opt/secret/bin/tool', args: ['--token', 'ghp_SECRET_ARG'], env: { API_KEY: 'sk-SECRET-ENV' } }
    writeConfig(s, 'claude', JSON.stringify({
      oauthAccount: { emailAddress: 'someone@example.com' },
      mcpServers: { secret: secrets, 'agent-inbox': { command: join(dir, 'bin', 'node'), args: [join(dir, 'dist', 'mcp-server.js')], env: { AGENT_INBOX_TOKEN: 'sk-SECRET-OURS' } } },
    }))
    writeConfig(s, 'copilot', JSON.stringify({
      mcpServers: { secret: secrets, 'agent-inbox': { type: 'local', command: process.execPath, args: [join(root, 'dist', 'mcp-server.js')], env: { X: 'sk-SECRET-COPILOT' } } },
    }))

    const hosts = read(s)
    const text = JSON.stringify(hosts)
    for (const secret of ['/opt/secret', 'ghp_SECRET_ARG', 'sk-SECRET', 'someone@example.com', process.execPath]) {
      expect(text, secret).not.toContain(secret)
    }
    expect(Object.keys(hosts.claude).sort()).toEqual(['kind', 'runtimeId', 'version'])
    expect(Object.keys(hosts.copilot).sort()).toEqual(['kind', 'path'])
  })

  it('reads Claude\'s backstop hooks: none, one runtime, a checkout, or more than one build', () => {
    const s = scratch()
    expect(read(s).hooks).toEqual({ kind: 'none' })

    const old = installRuntimeVersion(s.runtimeRoot, '1.2.4')
    const runtimeHook = { command: join(old, 'bin', 'node'), entry: join(old, 'dist', 'hook-cli.js') }
    writeHooks(s, [runtimeHook, runtimeHook])
    expect(read(s).hooks).toEqual({ kind: 'runtime', version: '1.2.4', runtimeId: old.slice(s.runtimeRoot.length + 1) })

    const root = checkout()
    const checkoutHook = { command: process.execPath, entry: join(root, 'dist', 'hook-cli.js') }
    writeHooks(s, [checkoutHook, checkoutHook])
    expect(read(s).hooks).toEqual({ kind: 'checkout', path: realpathSync(root) })

    writeHooks(s, [runtimeHook, checkoutHook])
    expect(read(s).hooks).toEqual({ kind: 'unknown' })

    // #232: a runtime copied or extracted outside the root is not Setup's, and the
    // hook installer refuses beside it rather than taking it for another tool's
    const copied = installRuntimeVersion(mkdtempSync(join(tmpdir(), 'agent-hosts-copied-')), '1.2.4')
    const copiedHook = { command: join(copied, 'bin', 'node'), entry: join(copied, 'dist', 'hook-cli.js') }
    writeHooks(s, [copiedHook, copiedHook])
    expect(read(s).hooks).toEqual({ kind: 'unknown' })

    writeFileSync(join(s.home, '.claude', 'settings.json'), '{ not json')
    expect(read(s).hooks).toEqual({ kind: 'unknown' })
  })

  it('verifies each registered runtime through the injected verifier, with this host\'s app expectations relaxed', () => {
    const s = scratch()
    const dir = installRuntimeVersion(s.runtimeRoot, '1.2.8')
    registerRuntime(s, 'claude', dir)
    const calls: Array<Record<string, unknown>> = []
    const counting: RuntimeVerifier = (opts) => {
      calls.push(opts)
      return verifyRuntimePayload(opts)
    }
    expect(read(s, counting).claude).toMatchObject({ kind: 'runtime', version: '1.2.8' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ root: realpathSync(dir), requiredEntrypoints: [], requiredFiles: [] })
    expect(calls[0]).not.toHaveProperty('expectedPackageVersion')
    expect(calls[0]).not.toHaveProperty('expectedManifestDigest')
  })

  it('agrees with the installer on which registrations Setup owns and may replace', () => {
    const arrangements: Array<[string, (s: Scratch) => void]> = [
      ['absent file', () => {}],
      ['no entry', (s) => writeConfig(s, 'claude', JSON.stringify({ mcpServers: {} }))],
      ['old runtime', (s) => registerRuntime(s, 'claude', installRuntimeVersion(s.runtimeRoot, '1.2.8'))],
      ['current runtime', (s) => registerRuntime(s, 'claude', installRuntimeVersion(s.runtimeRoot, '1.3.0'))],
      ['checkout', (s) => registerHost(s.home, 'claude', process.execPath, join(checkout(), 'dist', 'mcp-server.js'))],
      ['a runtime outside the root', (s) => registerRuntime(s, 'claude', installRuntimeVersion(mkdtempSync(join(tmpdir(), 'agent-hosts-elsewhere-')), '1.2.8'))],
      ['split', (s) => {
        const dir = installRuntimeVersion(s.runtimeRoot, '1.2.8')
        registerHost(s.home, 'claude', join(dir, 'bin', 'node'), join(checkout(), 'dist', 'mcp-server.js'))
      }],
      ['two runtimes', (s) => {
        const a = installRuntimeVersion(s.runtimeRoot, '1.2.8')
        const b = installRuntimeVersion(s.runtimeRoot, '1.3.0')
        registerHost(s.home, 'claude', join(a, 'bin', 'node'), join(b, 'dist', 'mcp-server.js'))
      }],
      ['tampered', (s) => {
        const dir = installRuntimeVersion(s.runtimeRoot, '1.2.8')
        registerRuntime(s, 'claude', dir)
        writeFileSync(join(dir, 'dist', 'mcp-server.js'), '// tampered\n')
      }],
      ['invalid JSON', (s) => writeConfig(s, 'claude', '{')],
      ['malformed', (s) => writeConfig(s, 'claude', JSON.stringify({ mcpServers: { 'agent-inbox': { command: 'x' } } }))],
    ]
    for (const [label, arrange] of arrangements) {
      const s = scratch()
      arrange(s)
      const installer = spawnSync(process.execPath, [
        join(REPO, 'scripts', 'runtime-config.mjs'), 'registration',
        '--file', configFile(s, 'claude'), '--runtime-root', s.runtimeRoot,
      ], { encoding: 'utf8' })
      expect(installer.status, installer.stderr).toBe(0)
      const verdict = (JSON.parse(installer.stdout) as { status: string }).status
      const kind = read(s).claude.kind
      expect(kind === 'runtime', `${label}: installer says ${verdict}, viewer says ${kind}`).toBe(verdict === 'owned')
      expect(kind === 'none', `${label}: installer says ${verdict}, viewer says ${kind}`).toBe(verdict === 'absent')
    }
  })

  // #218: the hook installer attributes every agent-inbox-shaped hook entry by
  // the rule Setup reports Claude's hooks with, so the set it refuses to
  // duplicate (or replaces on request) is the one Setup names, and another
  // tool's look-alike is never taken for one.
  it('agrees with the hook installer on which install each hook entry runs', () => {
    const elsewhere = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))
    const toolRoot = (): string => {
      const root = elsewhere('agent-hosts-tool-')
      mkdirSync(join(root, 'dist'))
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-inbox-companion' }))
      writeFileSync(join(root, 'dist', 'hook-cli.js'), '// another tool\n')
      return root
    }
    const tool = (): string => join(toolRoot(), 'dist', 'hook-cli.js')
    // `<link>/..` is the parent of the link's target to the OS, but the link's
    // own parent to realpathSync, which applies `..` before following it (#228)
    const throughLink = (target: string): string => {
      mkdirSync(join(target, 'lib'), { recursive: true })
      const dir = elsewhere('agent-hosts-link-')
      symlinkSync(join(target, 'lib'), join(dir, 'lib'))
      return `${dir}/lib/..`
    }
    const withNode = (dir: string): string => {
      mkdirSync(join(dir, 'bin'), { recursive: true })
      writeFileSync(join(dir, 'bin', 'node'), '')
      return dir
    }
    const inRuntime = (dir: string) => ({ command: join(dir, 'bin', 'node'), entry: join(dir, 'dist', 'hook-cli.js') })
    const checkoutEntry = (): string => join(checkout(), 'dist', 'hook-cli.js')
    // [label, arrange, what the installer attributes it to]
    const arrangements: Array<[string, (s: Scratch) => { command: string; entry: string }, string]> = [
      ['runtime', (s) => inRuntime(installRuntimeVersion(s.runtimeRoot, '1.2.4')), 'runtime'],
      ['checkout', () => ({ command: process.execPath, entry: checkoutEntry() }), 'checkout'],
      ['checkout, node on PATH', () => ({ command: 'node', entry: checkoutEntry() }), 'checkout'],
      ['another tool\'s dist/hook-cli.js', () => ({ command: process.execPath, entry: tool() }), 'other'],
      ['a relative entry', () => ({ command: 'node', entry: 'dist/hook-cli.js' }), 'other'],
      // #232: copied or extracted elsewhere, or installed under another runtime root
      ['a runtime outside the root', () => inRuntime(installRuntimeVersion(elsewhere('agent-hosts-elsewhere-'), '1.2.4')), 'elsewhere'],
      ['a tampered runtime outside the root', () => {
        const dir = installRuntimeVersion(elsewhere('agent-hosts-elsewhere-'), '1.2.4')
        writeFileSync(join(dir, 'dist', 'hook-cli.js'), '// tampered\n')
        return inRuntime(dir)
      }, 'unknown'],
      ['a runtime outside the root, run by another node', () => ({
        command: process.execPath, entry: inRuntime(installRuntimeVersion(elsewhere('agent-hosts-elsewhere-'), '1.2.4')).entry,
      }), 'unknown'],
      ['another product\'s runtime outside the root', () => inRuntime(installRuntimeVersion(elsewhere('agent-hosts-elsewhere-'), '1.2.4', {
        product: 'agent-inbox-companion-runtime',
      })), 'unknown'],
      ['a missing entry', () => ({ command: process.execPath, entry: join(elsewhere('agent-hosts-gone-'), 'dist', 'hook-cli.js') }), 'dead'],
      ['a missing node', () => ({ command: join(elsewhere('agent-hosts-gone-'), 'node'), entry: checkoutEntry() }), 'dead'],
      // #228: these run, so they are not dead, but they cannot be verified either
      ['a live <link>/../bin/node', () => ({ command: `${throughLink(withNode(elsewhere('agent-hosts-node-')))}/bin/node`, entry: tool() }), 'unknown'],
      ['a live <link>/../dist/hook-cli.js', () => ({ command: process.execPath, entry: `${throughLink(toolRoot())}/dist/hook-cli.js` }), 'unknown'],
      ['a <link>/../bin/node the OS cannot find either', () => ({
        command: `${throughLink(elsewhere('agent-hosts-gone-'))}/bin/node`, entry: tool(),
      }), 'dead'],
      ['split', (s) => ({ command: join(installRuntimeVersion(s.runtimeRoot, '1.2.4'), 'bin', 'node'), entry: checkoutEntry() }), 'unknown'],
      ['node on PATH, runtime entry', (s) => ({ command: 'node', entry: join(installRuntimeVersion(s.runtimeRoot, '1.2.4'), 'dist', 'hook-cli.js') }), 'unknown'],
      ['tampered', (s) => {
        const dir = installRuntimeVersion(s.runtimeRoot, '1.2.4')
        writeFileSync(join(dir, 'dist', 'hook-cli.js'), '// tampered\n')
        return inRuntime(dir)
      }, 'unknown'],
    ]
    const seen = new Set<string>()
    const attributedKinds = new Set<string>()
    for (const [label, arrange, expected] of arrangements) {
      const s = scratch()
      const launcher = arrange(s)
      writeHooks(s, [launcher, launcher])
      const installer = spawnSync(process.execPath, [
        join(REPO, 'scripts', 'runtime-config.mjs'), 'foreign-hooks', '--replace-existing',
        '--settings', join(s.home, '.claude', 'settings.json'), '--runtime-root', s.runtimeRoot,
        '--entry', join(s.home, 'this-install', 'dist', 'hook-cli.js'),
      ], { encoding: 'utf8' })
      // refused even with --replace-existing: an entry it cannot verify
      expect([0, 1], `${label}: ${installer.stderr}`).toContain(installer.status)
      const removed = installer.status === 0 ? JSON.parse(installer.stdout) as Array<{ owner: { kind: string } }> : []
      const attributed = installer.status === 1 ? 'unknown' : removed[0]?.owner.kind ?? 'other'
      expect(attributed, `${label}: ${installer.stderr}`).toBe(expected)
      attributedKinds.add(attributed)
      // the installer splits Setup's "unknown" in three: dead (a path is gone, so
      // it cannot run, and --replace-existing removes it), elsewhere (a verified
      // runtime outside the root: another install's, never Setup's) and unknown
      const kind = read(s).hooks.kind
      const asSetup = attributed === 'dead' || attributed === 'elsewhere' ? 'unknown' : attributed
      expect(asSetup, `${label}: installer says ${attributed}, viewer says ${kind}`).toBe(kind)
      seen.add(kind)
    }
    expect([...seen].sort()).toEqual(['checkout', 'other', 'runtime', 'unknown'])
    expect([...attributedKinds].sort()).toEqual(['checkout', 'dead', 'elsewhere', 'other', 'runtime', 'unknown'])
  })
})
