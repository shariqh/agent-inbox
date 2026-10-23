// Issue #294: Setup removes the runtimes nothing uses. Each Setup runtime under
// ~/.agent-inbox/runtime/<id>/ is about 171 MB, and the installer prunes only
// during an install, keeping the newest previous one.
//
// ONE rule says what "uses" means for every prune (scripts/runtime-config.mjs):
// a host config naming a runtime's id anywhere, or a launcher in it resolving
// into the runtime's directory, or a running process naming the id.
// scripts/prune-runtimes.sh applies it: a dry run that changes nothing, then
// --apply under the shared setup lock, removing each unused runtime through
// runtime-payload.mjs prune (#211/#214 trash semantics). A host config that
// cannot be read means nothing is removed at all.
import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hooksHome, installRuntime, installStaged, stageRuntime } from './hooks-runtime.js'
import type { HooksHome, StagedRuntime } from './hooks-runtime.js'
import { accentedRoot, RUNTIME_SPELLINGS } from './runtime-spellings.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = resolve(import.meta.dirname, '..')
const CONFIG_CLI = join(REPO, 'scripts', 'runtime-config.mjs')
const SCRIPT = join(REPO, 'scripts', 'prune-runtimes.sh')

interface ProcessEntry { pid: number; ppid: number; command: string }
type ProcessList = { ok: true; processes: ProcessEntry[] } | { ok: false; reason: string }
// The pieces no CLI exposes: the whole-name match, the process scan, and the
// verdicts with a process list a test chooses.
const config = (await import(pathToFileURL(CONFIG_CLI).href)) as {
  runtimeIdInText(text: string, runtimeId: string): boolean
  processesUsingRuntime(processes: ProcessEntry[], runtimeId: string, selfPid?: number): number[]
  listProcesses(options?: { psBin?: string }): ProcessList
  findUnusedRuntimes(options: { runtimeRoot: string; home: string; current?: string | null; processList?: () => ProcessList }): unknown
}
const { createSetupProcessRunner } = createRequire(import.meta.url)('../electron/setup-process.cjs') as {
  createSetupProcessRunner(options?: { env?: NodeJS.ProcessEnv }): {
    start(operation: { repoRoot: string; target: string; runtime: null }): Promise<{
      ok: boolean
      exitCode: number | null
      output: string
      target: string
    }>
  }
}

// Versions no other test file stages: a runtime id is content-derived, and a
// process another file runs from a runtime with the same id would count here.
const OLD = '1.2.2-p294'
const OLDER_HOOKS = '1.2.4-p294'
const APP = '1.7.0-p294'

const live = new Set<ChildProcess>()

afterEach(() => {
  for (const child of live) {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  live.clear()
  removeScratchDirs()
})

interface Fixture {
  h: HooksHome
  /** the app's own runtime payload, which prune-runtimes.sh runs from, as Setup runs it */
  app: StagedRuntime
}

function fixture(): Fixture {
  return { h: hooksHome(), app: stageRuntime(join(scratchDir('prune-app-'), 'payload'), APP) }
}

interface Run { status: number | null; stdout: string; stderr: string }

function prune(f: Fixture, args: string[] = [], env: NodeJS.ProcessEnv = f.h.env): Run {
  const result = spawnSync('/bin/bash', [join(f.app.dir, 'scripts', 'prune-runtimes.sh'), ...args], { encoding: 'utf8', env })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

interface Verdicts {
  status: 'ok' | 'unknown'
  reason?: string
  runtimes: Array<{ runtimeId: string; version: string | null; verdict: string; usedBy: string[]; pids: number[] }>
}

function unused(f: Fixture, extra: string[] = []): Verdicts {
  const result = spawnSync(process.execPath, [
    CONFIG_CLI, 'unused', '--runtime-root', f.h.runtimeRoot, '--home', f.h.home, ...extra,
  ], { encoding: 'utf8', env: f.h.env })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as Verdicts
}

function verdictOf(f: Fixture, runtimeId: string): Verdicts['runtimes'][number] | undefined {
  return unused(f).runtimes.find((runtime) => runtime.runtimeId === runtimeId)
}

function references(f: Fixture, runtimeId: string): { status: string; matches: Array<{ file: string }> } {
  const result = spawnSync(process.execPath, [
    CONFIG_CLI, 'references', '--runtime-root', f.h.runtimeRoot, '--runtime-id', runtimeId, '--home', f.h.home,
  ], { encoding: 'utf8', env: f.h.env })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as { status: string; matches: Array<{ file: string }> }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const files = (h: HooksHome) => ({
  claude: join(h.home, '.claude.json'),
  settings: join(h.home, '.claude', 'settings.json'),
  local: join(h.home, '.claude', 'settings.local.json'),
  copilot: join(h.home, '.copilot', 'mcp-config.json'),
  desktopMac: join(h.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  desktopLinux: join(h.home, '.config', 'Claude', 'claude_desktop_config.json'),
})

const launcher = (dir: string, entry = 'mcp-server.js') => ({ command: join(dir, 'bin', 'node'), args: [join(dir, 'dist', entry)] })

/** Claude's hooks as a Setup runtime's installer writes them. */
function hooksOf(dir: string): unknown {
  const hook = (sub: string) => ({ type: 'command', ...launcher(dir, 'hook-cli.js'), args: [join(dir, 'dist', 'hook-cli.js'), sub], timeout: 5 })
  return { hooks: { Notification: [{ hooks: [hook('notification')] }], Stop: [{ hooks: [hook('stop'), hook('watch')] }] } }
}

/** A real process whose command line names `path`, the way an MCP server started from a runtime does. */
async function runFrom(path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)", path], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  live.add(child)
  await new Promise<void>((ready, failed) => {
    child.stdout!.once('data', () => ready())
    child.once('error', failed)
  })
  return child
}

/** Every entry under `root`, with what a write, a lock or a trash cleanup would change. */
function snapshot(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const st = lstatSync(path)
      out.push(`${path}:${st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f'}:${st.size}:${st.mtimeMs}`)
      if (st.isDirectory()) walk(path)
    }
  }
  walk(root)
  return out
}

const runtimes = (h: HooksHome): string[] => readdirSync(h.runtimeRoot).sort()

describe('what counts as using a runtime (#294)', () => {
  // Each shape names one runtime; every one keeps it, and the installer's own
  // gate (`references`, used after an install) agrees.
  const SHAPES: Array<[string, (dir: string, h: HooksHome) => { file: string; value: unknown; label: string }]> = [
    ['a Claude Code user registration', (dir, h) => ({
      file: files(h).claude, label: 'Claude Code', value: { mcpServers: { 'agent-inbox': launcher(dir) } },
    })],
    ['a Claude Code project-local registration (projects.*.mcpServers)', (dir, h) => ({
      file: files(h).claude, label: 'Claude Code', value: { projects: { '/Users/me/src/app': { mcpServers: { inbox: launcher(dir) } } } },
    })],
    ['a split pair: the runtime\'s Node with another entry', (dir, h) => ({
      file: files(h).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: join(dir, 'bin', 'node'), args: ['/opt/elsewhere/server.js'] } } },
    })],
    ['a split pair: another Node with the runtime\'s entry', (dir, h) => ({
      file: files(h).copilot, label: 'Copilot CLI', value: { mcpServers: { inbox: { command: '/usr/local/bin/node', args: [join(dir, 'dist', 'mcp-server.js')] } } },
    })],
    ['an env value', (dir, h) => ({
      file: files(h).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: 'node', args: ['/opt/x/server.js'], env: { AGENT_INBOX_NODE: join(dir, 'bin', 'node') } } } },
    })],
    ['an sh -c wrapper', (dir, h) => ({
      file: files(h).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: '/bin/sh', args: ['-c', `exec '${join(dir, 'bin', 'node')}' '${join(dir, 'dist', 'mcp-server.js')}'`] } } },
    })],
    ['a hook written as one command string', (dir, h) => ({
      file: files(h).settings, label: 'Claude Code settings', value: { hooks: { Stop: [{ hooks: [{ type: 'command', command: `${join(dir, 'bin', 'node')} ${join(dir, 'dist', 'hook-cli.js')} stop` }] }] } },
    })],
    ['an argument after the first', (dir, h) => ({
      file: files(h).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: '/usr/bin/env', args: ['NODE_ENV=production', join(dir, 'bin', 'node'), join(dir, 'dist', 'mcp-server.js')] } } },
    })],
    ['Claude hooks in settings.json', (dir, h) => ({ file: files(h).settings, label: 'Claude Code settings', value: hooksOf(dir) })],
    ['Claude hooks in settings.local.json', (dir, h) => ({ file: files(h).local, label: 'Claude Code settings', value: hooksOf(dir) })],
    ['a Copilot CLI registration', (dir, h) => ({
      file: files(h).copilot, label: 'Copilot CLI', value: { mcpServers: { 'agent-inbox': launcher(dir) } },
    })],
    ['Claude Desktop on macOS', (dir, h) => ({
      file: files(h).desktopMac, label: 'Claude Desktop', value: { mcpServers: { 'agent-inbox': launcher(dir) } },
    })],
    ['Claude Desktop on Linux', (dir, h) => ({
      file: files(h).desktopLinux, label: 'Claude Desktop', value: { mcpServers: { 'agent-inbox': launcher(dir) } },
    })],
    ['a symlinked alias that does not name the runtime', (dir, h) => {
      mkdirSync(join(h.home, 'aliases'))
      symlinkSync(join(dir, 'bin', 'node'), join(h.home, 'aliases', 'inbox-node'))
      return { file: files(h).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: join(h.home, 'aliases', 'inbox-node'), args: ['/opt/x/server.js'] } } } }
    }],
    ['a home-relative alias', (dir, h) => {
      mkdirSync(join(h.home, 'aliases'))
      symlinkSync(join(dir, 'dist'), join(h.home, 'aliases', 'inbox-dist'))
      return { file: files(h).copilot, label: 'Copilot CLI', value: { mcpServers: { inbox: { command: 'node', args: ['~/aliases/inbox-dist/mcp-server.js'] } } } }
    }],
    // a path naming it that cannot be followed for another reason than absence still counts
    ['a path through a symlink loop', (dir, h) => {
      symlinkSync(join(h.home, 'loop'), join(h.home, 'loop'))
      const id = dir.slice(dir.lastIndexOf('/') + 1)
      return { file: files(h).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: 'node', args: [join(h.home, 'loop', id, 'dist', 'mcp-server.js')] } } } }
    }],
    // a whole argument is one path, spaces and all
    ['a symlinked shortcut whose path has a space', (dir, h) => {
      const shortcut = join(h.home, 'Library', 'Application Support', 'agent-inbox')
      mkdirSync(shortcut, { recursive: true })
      symlinkSync(join(dir, 'bin', 'node'), join(shortcut, 'node'))
      symlinkSync(join(dir, 'dist', 'mcp-server.js'), join(shortcut, 'mcp-server.js'))
      return { file: files(h).copilot, label: 'Copilot CLI', value: { mcpServers: { 'agent-inbox': { command: join(shortcut, 'node'), args: [join(shortcut, 'mcp-server.js')] } } } }
    }],
    ['an env value naming only the id', (dir, h) => ({
      file: files(h).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: 'node', args: ['/opt/x/server.js'], env: { AGENT_INBOX_RUNTIME: basename(dir) } } } },
    })],
    // a runtime id is content-derived, so another root can hold the very same one
    ['another root\'s copy of the same id', (dir, h) => {
      const copy = join(h.home, 'other-root', basename(dir))
      cpSync(dir, copy, { recursive: true })
      return { file: files(h).copilot, label: 'Copilot CLI', value: { mcpServers: { 'agent-inbox': launcher(copy) } } }
    }],
  ]

  it.each(SHAPES)('%s keeps the runtime it names', (_label, shape) => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    const { file, value, label } = shape(old.dir, f.h)
    writeJson(file, value)

    expect(verdictOf(f, old.runtimeId)).toMatchObject({ verdict: 'used', usedBy: [label] })
    const gate = references(f, old.runtimeId)
    expect(gate.status).toBe('referenced')
    // one match per launcher that uses it, all in the one file
    expect([...new Set(gate.matches.map((match) => match.file))]).toEqual([file])
  })

  it('does not count another runtime\'s launcher, a config key, or a longer name that begins with the id', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    const other = installRuntime(f.h, OLDER_HOOKS)
    writeJson(files(f.h).claude, {
      mcpServers: { 'agent-inbox': launcher(other.dir) },
      // Claude Code keys a project by its folder; running in one is no launcher
      projects: { [old.dir]: { allowedTools: [] } },
      notes: [`${old.dir}.tar.gz`, `${old.runtimeId}-backup`, `x${old.runtimeId}`],
    })

    expect(verdictOf(f, old.runtimeId)).toMatchObject({ verdict: 'unused', usedBy: [], pids: [] })
    expect(verdictOf(f, other.runtimeId)).toMatchObject({ verdict: 'used', usedBy: ['Claude Code'] })
    expect(references(f, old.runtimeId).status).toBe('unreferenced')
  })

  it('counts the id anywhere in a config value, not only in a launcher', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    writeJson(files(f.h).settings, { statusLine: { type: 'script', path: join(old.dir, 'dist', 'watch-cli.js') } })

    expect(verdictOf(f, old.runtimeId)).toMatchObject({ verdict: 'used', usedBy: ['Claude Code settings'] })
  })

  // The one exception: an absolute or ~/ path naming the id that is not there.
  // A bare id, or a path it cannot place, still counts.
  it('counts a named id unless it is a path to nothing', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    writeJson(files(f.h).copilot, { mcpServers: { gone: launcher(join(f.h.home, 'deleted-root', old.runtimeId)), home: { command: `~/deleted-root/${old.runtimeId}/bin/node` } } })
    expect(verdictOf(f, old.runtimeId)).toMatchObject({ verdict: 'unused', usedBy: [] })
    expect(references(f, old.runtimeId).status).toBe('unreferenced')

    for (const named of [`AGENT_INBOX_RUNTIME=${old.runtimeId}`, `$HOME/.agent-inbox/runtime/${old.runtimeId}/bin/node`, `runtime/${old.runtimeId}/bin/node`]) {
      writeJson(files(f.h).claude, { mcpServers: { inbox: { command: '/bin/sh', args: ['-c', `exec ${named}`] } } })
      expect(verdictOf(f, old.runtimeId), named).toMatchObject({ verdict: 'used', usedBy: ['Claude Code'] })
    }
  })

  // A folder is compared by (dev, ino), never by how a path spells it: on
  // macOS each of these reaches the runtime, whatever its string says. Once
  // as a path naming the id (a), once as a shortcut that does not (b).
  for (const [label, spell, here] of RUNTIME_SPELLINGS) {
    it.skipIf(!here)(`keeps a runtime a launcher reaches through ${label}`, () => {
      const f = fixture()
      const h = { ...f.h, runtimeRoot: accentedRoot(f.h.home) }
      const old = installRuntime(h, OLD)
      writeJson(files(h).claude, { mcpServers: { inbox: { command: spell(join(old.dir, 'bin', 'node')), args: [spell(join(old.dir, 'dist', 'mcp-server.js'))] } } })

      expect(verdictOf({ ...f, h }, old.runtimeId)).toMatchObject({ verdict: 'used', usedBy: ['Claude Code'] })
      expect(references({ ...f, h }, old.runtimeId).status).toBe('referenced')

      const shortcut = join(h.home, 'inbox-node')
      symlinkSync(spell(join(old.dir, 'bin', 'node')), shortcut)
      writeJson(files(h).claude, { mcpServers: { inbox: { command: shortcut, args: ['/opt/x/server.js'] } } })
      expect(verdictOf({ ...f, h }, old.runtimeId)).toMatchObject({ verdict: 'used', usedBy: ['Claude Code'] })
    })
  }

  // Errors only ever keep: a path stat refuses for another reason than absence.
  it.skipIf(process.getuid?.() === 0)('keeps a runtime that a path stat cannot follow names (EACCES)', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    const locked = join(f.h.home, 'locked')
    mkdirSync(join(locked, old.runtimeId, 'bin'), { recursive: true })
    writeJson(files(f.h).claude, { mcpServers: { inbox: { command: join(locked, old.runtimeId, 'bin', 'node') } } })
    chmodSync(locked, 0o000)
    try {
      expect(verdictOf(f, old.runtimeId)).toMatchObject({ verdict: 'used', usedBy: ['Claude Code'] })
      expect(references(f, old.runtimeId).status).toBe('referenced')
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it.skipIf(process.getuid?.() === 0)('keeps every runtime when a launcher path stat cannot follow lies in the runtime root', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    const other = installRuntime(f.h, OLDER_HOOKS)
    const locked = join(f.h.runtimeRoot, '.locked')
    mkdirSync(locked)
    symlinkSync(join(old.dir, 'bin', 'node'), join(locked, 'inbox-node'))
    writeJson(files(f.h).copilot, { mcpServers: { inbox: { command: join(locked, 'inbox-node') } } })
    chmodSync(locked, 0o000)
    try {
      expect(unused(f).runtimes.map((r) => [r.runtimeId, r.verdict])).toEqual(
        [[old.runtimeId, 'used'], [other.runtimeId, 'used']].sort(([a], [b]) => (a! < b! ? -1 : 1)),
      )
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  // `references` names the files, never what is in them: a hook's one
  // command string can carry a token.
  it('says which host config files use a runtime, never what is in them', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    writeJson(files(f.h).settings, { hooks: { Stop: [{ hooks: [{ type: 'command', command: `SLACK_TOKEN=xoxb-s3cret ${join(old.dir, 'bin', 'node')} ${join(old.dir, 'dist', 'hook-cli.js')} stop` }] }] } })
    const ask = (extra: string[]) => spawnSync(process.execPath, [
      CONFIG_CLI, 'references', '--runtime-root', f.h.runtimeRoot, '--runtime-id', old.runtimeId, '--home', f.h.home, ...extra,
    ], { encoding: 'utf8', env: f.h.env })

    const full = ask([])
    expect(full.status, full.stderr).toBe(0)
    expect(full.stdout).not.toContain('s3cret')
    expect((JSON.parse(full.stdout) as { matches: unknown[] }).matches).toEqual([{ file: files(f.h).settings, label: 'Claude Code settings' }])
    // what the installer asks for: the answer alone
    const status = ask(['--status'])
    expect(status.status, status.stderr).toBe(0)
    expect(status.stdout).toBe('referenced\n')
  })

  it('finds nothing in host configs that are not there', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)

    expect(unused(f)).toEqual({
      status: 'ok',
      runtimes: [{ runtimeId: old.runtimeId, version: OLD, verdict: 'unused', usedBy: [], pids: [] }],
    })
    expect(references(f, old.runtimeId).status).toBe('unreferenced')
  })

  // A config that exists but proves nothing could hide the one launcher that
  // still uses a runtime, so nothing at all may be removed.
  const UNREADABLE: Array<[string, (h: HooksHome) => string, string]> = [
    ['is not valid JSON', (h) => {
      writeJson(files(h).copilot, {})
      // an unquoted value: V8's message for this one quotes the text around it
      writeFileSync(files(h).copilot, '{"mcpServers": {"x": {"env": {"TOKEN": s3cret-value}}}}')
      return files(h).copilot
    }, 'is not valid JSON'],
    ['is a directory', (h) => {
      mkdirSync(files(h).settings, { recursive: true })
      return files(h).settings
    }, 'is not a regular file'],
    ['is a symlink to nothing', (h) => {
      mkdirSync(join(h.home, '.claude'), { recursive: true })
      symlinkSync(join(h.home, 'dotfiles', 'settings.json'), files(h).settings)
      return files(h).settings
    }, 'is a symlink to something that is not there'],
    ['sits under a symlinked folder whose target is gone', (h) => {
      symlinkSync(join(h.home, 'unmounted', 'claude'), join(h.home, '.claude'))
      return join(h.home, '.claude')
    }, 'is a symlink to something that is not there'],
    ['is larger than 64 MB', (h) => {
      writeJson(files(h).desktopMac, {})
      truncateSync(files(h).desktopMac, 64 * 1024 * 1024 + 1)
      return files(h).desktopMac
    }, 'is larger than 64 MB'],
    ['names more than 4096 paths in its launchers', (h) => {
      const args = Array.from({ length: 4097 }, (_, i) => `/opt/tool-${i}`)
      writeJson(files(h).claude, { mcpServers: { many: { command: 'node', args } } })
      return files(h).claude
    }, 'names more than 4096 paths in its launchers'],
  ]

  it.each(UNREADABLE)('removes nothing at all when a host config %s', (_label, arrange, why) => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    const culprit = arrange(f.h)

    const verdicts = unused(f)
    expect(verdicts.status).toBe('unknown')
    expect(verdicts.reason).toContain(culprit)
    expect(verdicts.reason).toContain(why)
    expect(verdicts.runtimes).toEqual([])
    expect(references(f, old.runtimeId).status).toBe('unknown')

    const applied = prune(f, ['--apply'])
    expect(applied.status).toBe(1)
    expect(applied.stderr).toContain(culprit)
    expect(applied.stderr).toContain(why)
    expect(applied.stderr).toContain('Nothing was removed')
    // says why without quoting the file, which can hold a secret
    expect(applied.stderr + applied.stdout).not.toContain('s3cret')
    expect(runtimes(f.h)).toEqual([old.runtimeId])
  })

  it.skipIf(process.getuid?.() === 0)('removes nothing at all when a host config cannot be read', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    writeJson(files(f.h).claude, {})
    chmodSync(files(f.h).claude, 0o000)
    try {
      expect(unused(f)).toMatchObject({ status: 'unknown', runtimes: [] })
      expect(prune(f, ['--apply']).status).toBe(1)
      expect(runtimes(f.h)).toEqual([old.runtimeId])
    } finally {
      chmodSync(files(f.h).claude, 0o644)
    }
  })
})

describe('the running-process check (#294)', () => {
  // Real-shaped ids from the manifest tool itself: a prerelease version made
  // of one id's tail gives a second id that begins with the first.
  function prefixPair(f: Fixture): { short: StagedRuntime; long: StagedRuntime } {
    const short = installRuntime(f.h, OLD)
    const long = installRuntime(f.h, short.runtimeId.slice('agent-inbox-runtime-'.length))
    expect(long.runtimeId.startsWith(short.runtimeId)).toBe(true)
    expect(long.runtimeId).not.toBe(short.runtimeId)
    return { short, long }
  }

  it('matches an id only as a whole name: /<id>/, /<id> at the end, never a prefix or suffix of a longer one', () => {
    const id = 'agent-inbox-runtime-1.2.2-darwin-arm64-b5fa4deef289134b'
    const longer = `agent-inbox-runtime-1.2.2-darwin-arm64-b5fa4deef289134b-darwin-arm64-36270557cd82e2ab`
    const root = '/Users/me/.agent-inbox/runtime'

    expect(config.runtimeIdInText(`${root}/${id}/bin/node ${root}/${id}/dist/mcp-server.js`, id)).toBe(true)
    expect(config.runtimeIdInText(`node --cwd ${root}/${id}`, id)).toBe(true)
    expect(config.runtimeIdInText(`AGENT_INBOX_RUNTIME=${id}`, id)).toBe(true)
    expect(config.runtimeIdInText(`'${root}/${id}/dist/watch-cli.js'`, id)).toBe(true)
    expect(config.runtimeIdInText(`${root}/${longer}/bin/node`, id)).toBe(false)
    expect(config.runtimeIdInText(`${root}/${id}.old/bin/node`, id)).toBe(false)
    expect(config.runtimeIdInText(`${root}/my-${id}/bin/node`, id)).toBe(false)
    expect(config.runtimeIdInText(`${root}/${longer}/bin/node`, longer)).toBe(true)
  })

  it('counts every process naming the id, except the checker and its own ancestors', () => {
    const id = 'agent-inbox-runtime-1.2.2-darwin-arm64-b5fa4deef289134b'
    const longer = `${id}-darwin-arm64-36270557cd82e2ab`
    const at = (runtime: string, entry: string) => `/Users/me/.agent-inbox/runtime/${runtime}/${entry}`
    const processes: ProcessEntry[] = [
      { pid: 1, ppid: 0, command: '/sbin/launchd' },
      { pid: 10, ppid: 1, command: `${at(longer, 'bin/node')} ${at(longer, 'dist/mcp-server.js')}` },
      { pid: 11, ppid: 1, command: `${at(id, 'bin/node')} ${at(id, 'dist/watch-cli.js')} item 7` },
      // the prune itself names the id it rechecks
      { pid: 20, ppid: 1, command: `/bin/bash prune-runtimes.sh --apply` },
      { pid: 21, ppid: 20, command: `node runtime-config.mjs unused --runtime-id ${id}` },
    ]

    expect(config.processesUsingRuntime(processes, id, 21)).toEqual([11])
    expect(config.processesUsingRuntime(processes, longer, 21)).toEqual([10])
    expect(config.processesUsingRuntime(processes.filter((p) => p.pid !== 11), id, 21)).toEqual([])
  })

  it('lists this process, and fails rather than guess when ps is missing or says something else', () => {
    const listed = config.listProcesses()
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.processes.some((p) => p.pid === process.pid && p.ppid > 0)).toBe(true)

    expect(config.listProcesses({ psBin: join(scratchDir('no-ps-'), 'ps') })).toMatchObject({ ok: false })
    const fake = join(scratchDir('fake-ps-'), 'ps')
    writeFileSync(fake, '#!/bin/sh\necho "  1 0 /sbin/launchd"\n')
    chmodSync(fake, 0o755)
    expect(config.listProcesses({ psBin: fake })).toMatchObject({ ok: false, reason: expect.stringMatching(/did not list this process/) })
  })

  it('removes nothing at all when the running processes cannot be listed', () => {
    const f = fixture()
    installRuntime(f.h, OLD)
    const failing = () => ({ ok: false as const, reason: 'ps failed (EACCES)' })

    expect(config.findUnusedRuntimes({ runtimeRoot: f.h.runtimeRoot, home: f.h.home, processList: failing })).toEqual({
      status: 'unknown',
      reason: 'the running processes cannot be listed: ps failed (EACCES)',
      runtimes: [],
    })
    // and a listing it can read decides as the CLI does
    const listed = () => ({ ok: true as const, processes: [{ pid: process.pid, ppid: 1, command: 'vitest' }] })
    expect(config.findUnusedRuntimes({ runtimeRoot: f.h.runtimeRoot, home: f.h.home, processList: listed })).toMatchObject({ status: 'ok', runtimes: [{ verdict: 'unused' }] })
  })

  it('keeps a runtime a running process uses, and removes it once that process is gone', async () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    const server = await runFrom(join(old.dir, 'dist', 'mcp-server.js'))

    expect(verdictOf(f, old.runtimeId)).toMatchObject({ verdict: 'in-use', pids: [server.pid] })
    const kept = prune(f, ['--apply'])
    expect(kept.status, kept.stderr).toBe(0)
    expect(kept.stdout).toContain(`Kept v${OLD} (${old.runtimeId}): in use by a running process (pid ${server.pid}).`)
    expect(runtimes(f.h)).toEqual([old.runtimeId])

    process.kill(server.pid!, 'SIGKILL')
    await new Promise((gone) => server.once('exit', gone))
    const removed = prune(f, ['--apply'])
    expect(removed.status, removed.stderr).toBe(0)
    expect(removed.stdout).toContain(`Removed v${OLD} (${old.runtimeId}).`)
    expect(existsSync(old.dir)).toBe(false)
  })

  it.each([
    ['the longer id is in use', 'long'],
    ['the shorter id is in use', 'short'],
  ] as const)('tells two real runtime ids apart where one begins the other: %s', async (_label, used) => {
    const f = fixture()
    const pair = prefixPair(f)
    const inUse = pair[used]
    const free = used === 'long' ? pair.short : pair.long
    const server = await runFrom(join(inUse.dir, 'bin', 'node'))

    const applied = prune(f, ['--apply'])

    expect(applied.status, applied.stderr).toBe(0)
    expect(applied.stdout).toContain(`(${inUse.runtimeId}): in use by a running process (pid ${server.pid}).`)
    expect(applied.stdout).toContain(`Removed v${free.version} (${free.runtimeId}).`)
    expect(runtimes(f.h)).toEqual([inUse.runtimeId])
  })
})

describe('prune-runtimes.sh (#294)', () => {
  it('a dry run lists what --apply would remove and changes nothing: no lock, no trash cleanup, no write', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    const hooks = installRuntime(f.h, OLDER_HOOKS)
    writeJson(files(f.h).settings, hooksOf(hooks.dir))
    // what an interrupted earlier prune left behind (#211)
    mkdirSync(join(f.h.runtimeRoot, `.trash-${old.runtimeId}-AbCdEf`, old.runtimeId), { recursive: true })
    const home = snapshot(f.h.home)
    const app = snapshot(f.app.dir)

    const dry = prune(f)

    expect(dry.status, dry.stderr).toBe(0)
    expect(dry.stdout).toContain(`Would remove v${OLD} (${old.runtimeId}).`)
    expect(dry.stdout).toContain(`Kept v${OLDER_HOOKS} (${hooks.runtimeId}): used by Claude Code settings.`)
    expect(dry.stdout).toContain('Dry run: nothing was removed. Run it again with --apply to remove 1 runtime.')
    expect(snapshot(f.h.home)).toEqual(home)
    expect(snapshot(f.app.dir)).toEqual(app)
    expect(existsSync(join(f.h.home, '.agent-inbox', 'install-agents.lock'))).toBe(false)
  })

  // The owner's Mac before its hooks moved to a checkout: 1.2.2 unused, 1.2.4
  // still running Claude's hooks, and this app's own runtime installed.
  it('removes only what nothing uses, through the runtime prune, and keeps this app\'s and the hooks\' runtimes', () => {
    const f = fixture()
    const current = installStaged(f.h, f.app)
    const old = installRuntime(f.h, OLD)
    const hooks = installRuntime(f.h, OLDER_HOOKS)
    writeJson(files(f.h).settings, hooksOf(hooks.dir))
    writeJson(files(f.h).claude, { mcpServers: { 'agent-inbox': launcher(current.dir) } })
    const leftover = join(f.h.runtimeRoot, `.trash-${old.runtimeId}-AbCdEf`)
    mkdirSync(join(leftover, old.runtimeId), { recursive: true })

    const applied = prune(f, ['--apply'])

    expect(applied.status, applied.stderr).toBe(0)
    // one line per runtime, in runtime id order, then what was removed
    expect(applied.stdout.trim().split('\n')).toEqual([
      `Removed v${OLD} (${old.runtimeId}).`,
      `Kept v${OLDER_HOOKS} (${hooks.runtimeId}): used by Claude Code settings.`,
      `Kept v${APP} (${current.runtimeId}): the runtime this prune runs from.`,
      'Removed 1 runtime.',
    ])
    expect(runtimes(f.h)).toEqual([current.runtimeId, hooks.runtimeId].sort())
    // the prune's #211/#214 cleanup took the leftover trash with it
    expect(existsSync(leftover)).toBe(false)
    // under the shared setup lock
    expect(lstatSync(join(f.h.home, '.agent-inbox', 'install-agents.lock')).isFile()).toBe(true)
  })

  it('says there is nothing to remove when nothing qualifies, or there is no runtime folder', () => {
    const f = fixture()
    expect(prune(f, ['--apply']).stdout).toContain('Nothing to remove.')
    const hooks = installRuntime(f.h, OLDER_HOOKS)
    writeJson(files(f.h).settings, hooksOf(hooks.dir))
    const dry = prune(f)
    expect(dry.status).toBe(0)
    expect(dry.stdout).toContain('Nothing to remove.')
    expect(runtimes(f.h)).toEqual([hooks.runtimeId])
  })

  it('refuses while another setup holds the lock, and removes nothing', async () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    const holder = spawn('/bin/bash', ['-c', `source '${join(f.app.dir, 'scripts', 'setup-lock.sh')}'; acquire_setup_lock holder || exit 3; echo held; exec sleep 60`], {
      detached: true,
      env: f.h.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    live.add(holder)
    await new Promise<void>((held) => holder.stdout!.once('data', () => held()))

    const blocked = prune(f, ['--apply'])

    expect(blocked.status).toBe(1)
    expect(blocked.stderr).toContain('prune-runtimes: another setup is already running')
    expect(runtimes(f.h)).toEqual([old.runtimeId])
  })

  it('never follows a symlinked runtime, never treats .trash-* or a folder without a manifest as a runtime, and never acts outside the runtime root', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    // a real runtime outside the root, reached through a link inside it
    const outside = stageRuntime(join(scratchDir('prune-outside-'), 'payload'), OLDER_HOOKS)
    const link = join(f.h.runtimeRoot, outside.runtimeId)
    symlinkSync(outside.dir, link)
    const trash = join(f.h.runtimeRoot, `.trash-${old.runtimeId}-QwErTy`, old.runtimeId)
    mkdirSync(trash, { recursive: true })
    writeFileSync(join(trash, 'runtime-manifest.json'), readFileSync(join(old.dir, 'runtime-manifest.json')))
    const stray = join(f.h.runtimeRoot, 'not-a-runtime')
    mkdirSync(stray)
    writeFileSync(join(stray, 'notes.txt'), 'mine\n')
    const outsideFiles = snapshot(outside.dir)

    const listed = unused(f).runtimes.map(({ runtimeId, verdict }) => [runtimeId, verdict])
    expect(listed).toEqual([[old.runtimeId, 'unused'], ['not-a-runtime', 'not-a-runtime']].sort())

    const applied = prune(f, ['--apply'])

    expect(applied.status, applied.stderr).toBe(0)
    expect(applied.stdout).toContain('Left not-a-runtime alone: it is not an Agent Inbox runtime.')
    expect(existsSync(old.dir)).toBe(false)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(snapshot(outside.dir)).toEqual(outsideFiles)
    expect(readFileSync(join(stray, 'notes.txt'), 'utf8')).toBe('mine\n')
  })

  it('leaves a runtime that does not verify in place, and says why', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    writeFileSync(join(old.dir, '.DS_Store'), 'finder\n')

    const applied = prune(f, ['--apply'])

    expect(applied.status).toBe(1)
    expect(applied.stdout).toContain(`Could not remove v${OLD} (${old.runtimeId}):`)
    expect(existsSync(join(old.dir, '.DS_Store'))).toBe(true)
    expect(existsSync(join(old.dir, 'runtime-manifest.json'))).toBe(true)
  })

  it('refuses outside a runtime, with a relative runtime root, with an unknown flag, or when its own runtime fails verification', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)

    const checkout = scratchDir('prune-checkout-')
    mkdirSync(join(checkout, 'scripts'))
    writeFileSync(join(checkout, 'scripts', 'prune-runtimes.sh'), readFileSync(SCRIPT))
    const fromCheckout = spawnSync('/bin/bash', [join(checkout, 'scripts', 'prune-runtimes.sh'), '--apply'], { encoding: 'utf8', env: f.h.env })
    expect(fromCheckout.status).toBe(2)
    expect(fromCheckout.stderr).toMatch(/run it from a packaged runtime/)

    expect(prune(f, ['--apply'], { ...f.h.env, AGENT_INBOX_RUNTIME_ROOT: 'runtime' }).status).toBe(2)
    expect(prune(f, ['--force']).status).toBe(2)

    writeFileSync(join(f.app.dir, 'dist', 'mcp-server.js'), '// changed after it was manifested\n')
    const tampered = prune(f, ['--apply'])
    expect(tampered.status).toBe(1)
    expect(tampered.stderr).toContain('this runtime failed verification, so nothing was removed')
    expect(runtimes(f.h)).toEqual([old.runtimeId])
  })

  it('describes itself in --help, which prints only its header comment', () => {
    const f = fixture()
    const help = prune(f, ['--help'])
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('DRY RUN IS THE DEFAULT')
    expect(help.stdout).toContain('prune-runtimes.sh --apply')
    expect(help.stdout.trimEnd().split('\n').filter((line) => !line.startsWith('#'))).toEqual([])
  })

  it('takes the lock only for --apply, before it removes anything, and removes only through runtime-payload.mjs prune', () => {
    const script = readFileSync(SCRIPT, 'utf8')
    const code = script.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
    const lock = code.indexOf('acquire_setup_lock prune-runtimes')
    const firstPrune = code.indexOf('"$PAYLOAD_HELPER" prune')

    expect(code.match(/acquire_setup_lock prune-runtimes/g)).toHaveLength(1)
    expect(code).toMatch(/if \[ "\$APPLY" -eq 1 \]; then acquire_setup_lock prune-runtimes \|\| exit 1; fi/)
    expect(lock).toBeGreaterThan(-1)
    expect(firstPrune).toBeGreaterThan(lock)
    expect(code.match(/"\$PAYLOAD_HELPER" prune/g)).toHaveLength(1)
    // every removal is the runtime prune: no rm, rmdir or mv in the script
    expect(code).not.toMatch(/(^|[\s;&|(])(rm|rmdir|mv)\s/m)
    // each unused runtime is checked again on its own just before its removal
    expect(code.indexOf('--runtime-id "$id"')).toBeGreaterThan(-1)
    expect(code.indexOf('--runtime-id "$id"')).toBeLessThan(firstPrune)
  })

  // Setup's fixed `prune-runtimes` target runs exactly this script, with --apply.
  it.skipIf(!['darwin', 'linux'].includes(process.platform))('removes the unused runtimes through Setup\'s fixed target', async () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    const hooks = installRuntime(f.h, OLDER_HOOKS)
    writeJson(files(f.h).settings, hooksOf(hooks.dir))

    const result = await createSetupProcessRunner({ env: f.h.env }).start({ repoRoot: f.app.dir, target: 'prune-runtimes', runtime: null })

    expect(result, result.output).toMatchObject({ ok: true, exitCode: 0, target: 'prune-runtimes' })
    expect(result.output).toContain(`Removed v${OLD} (${old.runtimeId}).`)
    expect(runtimes(f.h)).toEqual([hooks.runtimeId])
  })
})
