// test/runtime-uses.ts — host configs that do and do not use a Setup runtime
// (issue #294), shared by the script's tests (prune-runtimes.test.ts) and the
// viewer's agreement test (runtime-inventory.test.ts), so each case is written once.
//
// Deliberately NOT named *.test.ts: it is imported, never collected.
import { cpSync, mkdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { processStartedAt } from '../src/driver-pin.js'

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Every host config the prune gate reads, under `home`. */
export const configFiles = (home: string) => ({
  claude: join(home, '.claude.json'),
  settings: join(home, '.claude', 'settings.json'),
  local: join(home, '.claude', 'settings.local.json'),
  copilot: join(home, '.copilot', 'mcp-config.json'),
  desktopMac: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  desktopLinux: join(home, '.config', 'Claude', 'claude_desktop_config.json'),
})

export const launcher = (dir: string, entry = 'mcp-server.js') => ({ command: join(dir, 'bin', 'node'), args: [join(dir, 'dist', entry)] })

/** Claude's hooks as a Setup runtime's installer writes them. */
export function hooksOf(dir: string): unknown {
  const hook = (sub: string) => ({ type: 'command', ...launcher(dir, 'hook-cli.js'), args: [join(dir, 'dist', 'hook-cli.js'), sub], timeout: 5 })
  return { hooks: { Notification: [{ hooks: [hook('notification')] }], Stop: [{ hooks: [hook('stop'), hook('watch')] }] } }
}

/** One config that uses the runtime at `dir`, and the label Setup names it by. */
export type UseShape = (dir: string, home: string) => { file: string; value: unknown; label: string }

// Each shape names one runtime, and every one keeps it.
export const USE_SHAPES: Array<[string, UseShape]> = [
  ['a Claude Code user registration', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { 'agent-inbox': launcher(dir) } },
  })],
  ['a Claude Code project-local registration (projects.*.mcpServers)', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { projects: { '/Users/me/src/app': { mcpServers: { inbox: launcher(dir) } } } },
  })],
  ['a split pair: the runtime\'s Node with another entry', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: join(dir, 'bin', 'node'), args: ['/opt/elsewhere/server.js'] } } },
  })],
  ['a split pair: another Node with the runtime\'s entry', (dir, home) => ({
    file: configFiles(home).copilot, label: 'Copilot CLI', value: { mcpServers: { inbox: { command: '/usr/local/bin/node', args: [join(dir, 'dist', 'mcp-server.js')] } } },
  })],
  ['an env value', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: 'node', args: ['/opt/x/server.js'], env: { AGENT_INBOX_NODE: join(dir, 'bin', 'node') } } } },
  })],
  ['an sh -c wrapper', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: '/bin/sh', args: ['-c', `exec '${join(dir, 'bin', 'node')}' '${join(dir, 'dist', 'mcp-server.js')}'`] } } },
  })],
  ['a hook written as one command string', (dir, home) => ({
    file: configFiles(home).settings, label: 'Claude Code settings', value: { hooks: { Stop: [{ hooks: [{ type: 'command', command: `${join(dir, 'bin', 'node')} ${join(dir, 'dist', 'hook-cli.js')} stop` }] }] } },
  })],
  ['an argument after the first', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: '/usr/bin/env', args: ['NODE_ENV=production', join(dir, 'bin', 'node'), join(dir, 'dist', 'mcp-server.js')] } } },
  })],
  ['Claude hooks in settings.json', (dir, home) => ({ file: configFiles(home).settings, label: 'Claude Code settings', value: hooksOf(dir) })],
  ['Claude hooks in settings.local.json', (dir, home) => ({ file: configFiles(home).local, label: 'Claude Code settings', value: hooksOf(dir) })],
  ['a Copilot CLI registration', (dir, home) => ({
    file: configFiles(home).copilot, label: 'Copilot CLI', value: { mcpServers: { 'agent-inbox': launcher(dir) } },
  })],
  ['Claude Desktop on macOS', (dir, home) => ({
    file: configFiles(home).desktopMac, label: 'Claude Desktop', value: { mcpServers: { 'agent-inbox': launcher(dir) } },
  })],
  ['Claude Desktop on Linux', (dir, home) => ({
    file: configFiles(home).desktopLinux, label: 'Claude Desktop', value: { mcpServers: { 'agent-inbox': launcher(dir) } },
  })],
  ['a value outside any launcher', (dir, home) => ({
    file: configFiles(home).settings, label: 'Claude Code settings', value: { statusLine: { type: 'script', path: join(dir, 'dist', 'watch-cli.js') } },
  })],
  ['a bare id in a shell string', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: '/bin/sh', args: ['-c', `exec AGENT_INBOX_RUNTIME=${dir.slice(dir.lastIndexOf('/') + 1)} node x.js`] } } },
  })],
  // paths it cannot place still count: a shell expands them where it runs
  ['a $HOME path in a shell string', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: '/bin/sh', args: ['-c', `exec $HOME/.agent-inbox/runtime/${dir.slice(dir.lastIndexOf('/') + 1)}/bin/node x.js`] } } },
  })],
  ['a relative path in a shell string', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: '/bin/sh', args: ['-c', `cd ~/.agent-inbox && exec runtime/${dir.slice(dir.lastIndexOf('/') + 1)}/bin/node x.js`] } } },
  })],
  ['a symlinked alias that does not name the runtime', (dir, home) => {
    mkdirSync(join(home, 'aliases'))
    symlinkSync(join(dir, 'bin', 'node'), join(home, 'aliases', 'inbox-node'))
    return { file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: join(home, 'aliases', 'inbox-node'), args: ['/opt/x/server.js'] } } } }
  }],
  ['a home-relative alias', (dir, home) => {
    mkdirSync(join(home, 'aliases'))
    symlinkSync(join(dir, 'dist'), join(home, 'aliases', 'inbox-dist'))
    return { file: configFiles(home).copilot, label: 'Copilot CLI', value: { mcpServers: { inbox: { command: 'node', args: ['~/aliases/inbox-dist/mcp-server.js'] } } } }
  }],
  // a path naming it that cannot be followed for another reason than absence still counts
  ['a path through a symlink loop', (dir, home) => {
    symlinkSync(join(home, 'loop'), join(home, 'loop'))
    const id = dir.slice(dir.lastIndexOf('/') + 1)
    return { file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: 'node', args: [join(home, 'loop', id, 'dist', 'mcp-server.js')] } } } }
  }],
  // a whole argument is one path, spaces and all
  ['a symlinked shortcut whose path has a space', (dir, home) => {
    const shortcut = join(home, 'Library', 'Application Support', 'agent-inbox')
    mkdirSync(shortcut, { recursive: true })
    symlinkSync(join(dir, 'bin', 'node'), join(shortcut, 'node'))
    symlinkSync(join(dir, 'dist', 'mcp-server.js'), join(shortcut, 'mcp-server.js'))
    return { file: configFiles(home).copilot, label: 'Copilot CLI', value: { mcpServers: { 'agent-inbox': { command: join(shortcut, 'node'), args: [join(shortcut, 'mcp-server.js')] } } } }
  }],
  ['an env value naming only the id', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: 'node', args: ['/opt/x/server.js'], env: { AGENT_INBOX_RUNTIME: basename(dir) } } } },
  })],
  // a runtime id is content-derived, so another root can hold the very same one
  ['another root\'s copy of the same id', (dir, home) => {
    const copy = join(home, 'other-root', basename(dir))
    cpSync(dir, copy, { recursive: true })
    return { file: configFiles(home).copilot, label: 'Copilot CLI', value: { mcpServers: { 'agent-inbox': launcher(copy) } } }
  }],
  // shell punctuation glued to the id: the text up to it still names its folder
  ['cd <R>&& in an sh -c string', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: '/bin/sh', args: ['-c', `cd ${dir}&&exec ./bin/node dist/mcp-server.js`] } } },
  })],
  ['a `printf %s <R>` substitution', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: '/bin/sh', args: ['-c', `exec \`printf %s ${dir}\`/bin/node dist/mcp-server.js`] } } },
  })],
  ['a (cd <R>) subshell', (dir, home) => ({
    file: configFiles(home).claude, label: 'Claude Code', value: { mcpServers: { inbox: { command: '/bin/sh', args: ['-c', `(cd ${dir})&&exec node dist/mcp-server.js`] } } },
  })],
  // the whole string is no path, so only the folder of the piece `<R>&&exec` decides
  ['cd <R>&& in a hook\'s one command string', (dir, home) => ({
    file: configFiles(home).settings, label: 'Claude Code settings', value: { hooks: { Stop: [{ hooks: [{ type: 'command', command: `/bin/sh -c 'cd ${dir}&&exec ./bin/node dist/hook-cli.js stop'` }] }] } },
  })],
  // the folder ending at the id is there, though the file is not
  ['a path into it to a file it does not have', (dir, home) => ({
    file: configFiles(home).settings, label: 'Claude Code settings', value: { statusLine: { type: 'command', command: join(dir, 'dist', 'status.js') } },
  })],
]

/**
 * Configs that name the runtime at `dir` without using it: absolute and `~/`
 * paths that are not there (the one exception to a named id), a config key,
 * and longer names that begin or end with the id.
 */
export function notUses(dir: string, home: string): Array<{ file: string; value: unknown }> {
  const id = basename(dir)
  return [
    { file: configFiles(home).copilot, value: { mcpServers: { gone: launcher(join(home, 'deleted-root', id)), home: { command: `~/deleted-root/${id}/bin/node` } } } },
    { file: configFiles(home).claude, value: { projects: { [dir]: { allowedTools: [] } }, notes: [`${dir}.tar.gz`, `${id}-backup`, `x${id}`] } },
  ]
}

// A config that exists but proves nothing could hide the one launcher that
// still uses a runtime, so nothing at all may be removed. Each returns the
// path a refusal names, and says what the refusal says about it.
export const UNREADABLE_CONFIGS: Array<[string, (home: string) => string, string]> = [
  ['is not valid JSON', (home) => {
    writeJson(configFiles(home).copilot, {})
    // an unquoted value: V8's message for this one quotes the text around it
    writeFileSync(configFiles(home).copilot, '{"mcpServers": {"x": {"env": {"TOKEN": s3cret-value}}}}')
    return configFiles(home).copilot
  }, 'is not valid JSON'],
  ['is a directory', (home) => {
    mkdirSync(configFiles(home).settings, { recursive: true })
    return configFiles(home).settings
  }, 'is not a regular file'],
  ['is a symlink to nothing', (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    symlinkSync(join(home, 'dotfiles', 'settings.json'), configFiles(home).settings)
    return configFiles(home).settings
  }, 'is a symlink to something that is not there'],
  ['sits under a symlinked folder whose target is gone', (home) => {
    symlinkSync(join(home, 'unmounted', 'claude'), join(home, '.claude'))
    return join(home, '.claude')
  }, 'is a symlink to something that is not there'],
  // stat's own message names the path alone; the code keeps one format (#337)
  ['is a symlink loop', (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    symlinkSync(configFiles(home).settings, configFiles(home).settings)
    return configFiles(home).settings
  }, 'is unreadable (ELOOP)'],
  ['is larger than 64 MB', (home) => {
    writeJson(configFiles(home).desktopMac, {})
    truncateSync(configFiles(home).desktopMac, 64 * 1024 * 1024 + 1)
    return configFiles(home).desktopMac
  }, 'is larger than 64 MB'],
  ['names more than 4096 paths in its launchers', (home) => {
    const args = Array.from({ length: 4097 }, (_, i) => `/opt/tool-${i}`)
    writeJson(configFiles(home).claude, { mcpServers: { many: { command: 'node', args } } })
    return configFiles(home).claude
  }, 'names more than 4096 paths in its launchers'],
]

// ── driver pins (#412) ──────────────────────────────────────────────────────
// A running agent-inbox-driver pins the runtime it runs from in
// <runtime root>/.pins/<runtime id>/<launch id>. These cases are shared by the
// script's tests (runtime-pins.test.ts) and the viewer's agreement test.

export const PIN_LAUNCH = '11111111-2222-4333-8444-555555555555'

/** When `pid` started, exactly as a driver records it (src/driver-pin.ts). */
export function startOf(pid: number): string {
  const started = processStartedAt(pid)
  if (!started) throw new Error(`ps cannot say when ${pid} started`)
  return started
}

/** A pid that is no longer running. */
export function goneProcess(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!
}

/** Writes a pin file, as a driver does, and returns its path. */
export function writePinFile(runtimeRoot: string, runtimeId: string, pin: { pid: number; startedAt: string; launchId?: string }, raw?: string): string {
  const launchId = pin.launchId ?? PIN_LAUNCH
  const dir = join(runtimeRoot, '.pins', runtimeId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, launchId)
  writeFileSync(path, raw ?? JSON.stringify({ v: 1, launchId, pid: pin.pid, startedAt: pin.startedAt }))
  return path
}

const livePin = () => ({ pid: process.pid, startedAt: startOf(process.pid) })

/** Pins and look-alikes, and whether each keeps the runtime `runtimeId` (this process stands in for the driver). */
export const PIN_CASES: Array<[string, (runtimeRoot: string, runtimeId: string) => void, boolean]> = [
  ['a running driver\'s pin', (root, id) => { writePinFile(root, id, livePin()) }, true],
  ['a pin whose driver has exited', (root, id) => { writePinFile(root, id, { pid: goneProcess(), startedAt: 'Thu Jan 1 00:00:00 1970' }) }, false],
  ['a running driver\'s pin on another runtime', (root) => { writePinFile(root, 'another-runtime', livePin()) }, false],
  ['a pin whose name is no launch id', (root, id) => { writePinFile(root, id, { ...livePin(), launchId: 'not-a-launch' }) }, false],
  ['a pin naming another launch than its own', (root, id) => {
    writePinFile(root, id, livePin(), JSON.stringify({ v: 1, launchId: '99999999-2222-4333-8444-555555555555', ...livePin() }))
  }, false],
  ['a pin that is not JSON', (root, id) => { writePinFile(root, id, livePin(), '{"v":1,') }, false],
  ['a symlink to a running driver\'s pin', (root, id) => {
    const real = writePinFile(join(root, '..', 'elsewhere'), id, livePin())
    mkdirSync(join(root, '.pins', id), { recursive: true })
    symlinkSync(real, join(root, '.pins', id, PIN_LAUNCH))
  }, false],
  ['a symlinked pin folder', (root, id) => {
    writePinFile(join(root, '..', 'elsewhere'), id, livePin())
    mkdirSync(join(root, '.pins'), { recursive: true })
    symlinkSync(join(root, '..', 'elsewhere', '.pins', id), join(root, '.pins', id))
  }, false],
  ['a symlinked .pins', (root, id) => {
    writePinFile(join(root, '..', 'elsewhere'), id, livePin())
    symlinkSync(join(root, '..', 'elsewhere', '.pins'), join(root, '.pins'))
  }, false],
]
