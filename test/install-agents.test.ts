import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { constants } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = resolve(import.meta.dirname, '..')
const SCRIPT = join(REPO, 'scripts', 'install-agents.sh')
const HOOK_SCRIPT = join(REPO, 'scripts', 'install-hooks.sh')
const BEGIN = '<!-- agent-inbox:begin -->'
const END = '<!-- agent-inbox:end -->'
const SNIPPET_PATH = join(REPO, 'docs', 'reporting-snippet.md')
// The live import the owner keeps in ~/.claude/CLAUDE.md, verbatim in shape.
const IMPORT_LINE = `@${SNIPPET_PATH}`
// Two strings that exist ONLY in the shared snippet — neither host appendix
// contains them — so their presence/absence is exactly "was the snippet inlined".
const SNIPPET_LINE = 'One ask, one surface'
const SNIPPET_HEADING = '## Flags (one-shot attention)'

afterEach(removeScratchDirs)

interface Fixture {
  home: string
  env: NodeJS.ProcessEnv
  claudeFile: string
  copilotFile: string
  log: string
  fakebin: string
  state: string
  // The installer's TMPDIR, so its private work directory can be inspected.
  tmp: string
}

function fixture(): Fixture {
  const home = scratchDir('agent-installer-')
  const fakebin = join(home, 'fakebin')
  const state = join(home, 'state')
  const log = join(home, 'cli.log')
  const tmp = join(home, 'tmp')
  mkdirSync(fakebin)
  mkdirSync(state)
  mkdirSync(tmp)

  const cli = `#!/bin/sh
name="$(basename "$0")"
if [ "$name" = claude ]; then config="$CLAUDE_CONFIG"; else config="$COPILOT_CONFIG"; fi
printf '%s %s\\n' "$name" "$*" >> "$INSTALL_LOG"
case "$1:$2" in
  mcp:get)
    test "\${FAIL_GET:-}" != "$name" || exit 9
    test -f "$INSTALL_STATE/$name" || exit 1
    if [ "$name" = claude ]; then
      echo "  Scope: \${CLAUDE_SCOPE:-User config} (available in all your projects)"
    else
      echo "{ \\"agent-inbox\\": { \\"source\\": \\"\${COPILOT_SCOPE:-user}\\" } }"
    fi
    ;;
  mcp:add)
    test "\${FAIL_ADD:-}" != "$name" || exit 9
    if [ "\${CORRUPT_CONFIG_ON_ADD:-}" = "$name" ]; then
      touch "$INSTALL_STATE/$name"
      printf '{ not json\\n' > "$config"
      exit 0
    fi
    if [ "\${MUTATE_THEN_HANG_ADD:-}" = "$name" ]; then
      touch "$INSTALL_STATE/$name"
      printf '{"mcpServers":{"agent-inbox":{"command":"partial"}}}\\n' > "$config"
      touch "$INSTALL_STATE/$name.mutated"
      trap 'exit 143' TERM INT
      while :; do sleep 1; done
    fi
    if [ "\${HANG_ADD:-}" = "$name" ]; then
      printf '%s\\n' "$$" > "$INSTALL_STATE/$name.hanging-pid"
      touch "$INSTALL_STATE/$name.hanging"
      trap 'exit 143' TERM INT
      while :; do sleep 1; done
    fi
    if [ "\${FAIL_ADD_ONCE:-}" = "$name" ] && [ ! -f "$INSTALL_STATE/$name.add-failed" ]; then
      touch "$INSTALL_STATE/$name.add-failed"
      exit 9
    fi
    touch "$INSTALL_STATE/$name"
    printf '{"mcpServers":{"agent-inbox":{"command":"%s"}}}\\n' "$*" > "$config"
    ;;
  mcp:remove)
    test "\${FAIL_REMOVE:-}" != "$name" || exit 9
    if [ "\${HANG_REMOVE:-}" = "$name" ]; then
      printf '%s\\n' "$$" > "$INSTALL_STATE/$name.remove-pid"
      while :; do sleep 1; done
    fi
    # Like the real hosts, refuse to remove a server that is not registered.
    if [ ! -f "$INSTALL_STATE/$name" ]; then
      echo "No user-scoped MCP server found with name: agent-inbox" >&2
      exit 1
    fi
    rm -f "$INSTALL_STATE/$name"
    printf '{"mcpServers":{}}\\n' > "$config"
    if [ "\${PAUSE_AFTER_REMOVE:-}" = "$name" ]; then
      touch "$INSTALL_STATE/$name.removed"
      while [ ! -f "$INSTALL_STATE/$name.release" ]; do sleep 0.05; done
    fi
    ;;
  *) exit 2 ;;
esac
`
  for (const name of ['claude', 'copilot']) {
    const path = join(fakebin, name)
    writeFileSync(path, cli)
    chmodSync(path, 0o755)
  }
  writeFileSync(join(fakebin, 'jq'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(fakebin, 'jq'), 0o755)
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/lockf')) {
    const lockCommand = spawnSync('/bin/sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).stdout.trim()
    if (!lockCommand) throw new Error('install-agents tests require flock')
    symlinkSync(lockCommand, join(fakebin, 'flock'))
  }

  const selftest = join(home, 'selftest.js')
  const selftestMarker = join(state, 'selftest-ran')
  const entry = join(home, 'mcp-server.js')
  writeFileSync(selftest, "require('node:fs').writeFileSync(process.env.SELFTEST_MARKER, '')\n")
  writeFileSync(entry, 'process.exit(0)\n')

  const claudeFile = join(home, '.claude', 'CLAUDE.md')
  const copilotFile = join(home, '.copilot', 'copilot-instructions.md')
  mkdirSync(dirname(claudeFile), { recursive: true })
  mkdirSync(dirname(copilotFile), { recursive: true })
  writeFileSync(claudeFile, '# Claude personal rules\n\nKeep this.\n')
  writeFileSync(copilotFile, '# Copilot personal rules\n\nKeep this too.\n')
  const claudeConfig = join(home, '.claude.json')
  const copilotConfig = join(home, '.copilot', 'mcp-config.json')
  writeFileSync(claudeConfig, '{"mcpServers":{}}\n')
  writeFileSync(copilotConfig, '{"mcpServers":{}}\n')

  return {
    home,
    claudeFile,
    copilotFile,
    log,
    fakebin,
    state,
    tmp,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: tmp,
      PATH: `${fakebin}:/usr/bin:/bin`,
      AGENT_INBOX_NODE: process.execPath,
      AGENT_INBOX_MCP_ENTRY: entry,
      AGENT_INBOX_SELFTEST_ENTRY: selftest,
      SELFTEST_MARKER: selftestMarker,
      INSTALL_LOG: log,
      INSTALL_STATE: state,
      CLAUDE_CONFIG: claudeConfig,
      COPILOT_CONFIG: copilotConfig,
    },
  }
}

function run(f: Fixture, args: string[] = []) {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: f.env })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// The managed region only, so "the installer wrote X" cannot be satisfied by an
// X the human already had somewhere else in the file.
function managedBlock(text: string): string {
  const start = text.indexOf(BEGIN)
  const stop = text.indexOf(END)
  expect(start, 'managed begin marker').toBeGreaterThanOrEqual(0)
  expect(stop, 'managed end marker').toBeGreaterThan(start)
  return text.slice(start, stop + END.length)
}

// A directive only counts if it reaches THIS repo's snippet, so a fixture that
// spells the path differently has to genuinely land on the same file.
function linkSnippet(at: string): void {
  mkdirSync(dirname(at), { recursive: true })
  symlinkSync(SNIPPET_PATH, at)
}

function backups(file: string): string[] {
  const base = file.slice(file.lastIndexOf('/') + 1)
  return readdirSync(dirname(file)).filter((name) => name.startsWith(`${base}.bak.`))
}

function shareInstructionFile(f: Fixture): string {
  const shared = join(f.home, 'dotfiles', 'shared-agent-instructions.md')
  mkdirSync(dirname(shared), { recursive: true })
  writeFileSync(shared, '# Shared agent rules\n\nKeep this shared.\n')
  rmSync(f.claudeFile)
  rmSync(f.copilotFile)
  symlinkSync(shared, f.claudeFile)
  symlinkSync(shared, f.copilotFile)
  return shared
}

async function waitFor(path: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitForGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3000
  while (true) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for pid ${pid}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

// The installer's private work directories (`mktemp -d` under its TMPDIR). A
// finished run leaves none behind unless it is keeping a recovery snapshot.
function workDirs(f: Fixture): string[] {
  return readdirSync(f.tmp)
    .filter((name) => name.startsWith('agent-inbox-install.'))
    .map((name) => join(f.tmp, name))
}

// Staged instruction copies and MCP restore temporaries are created beside the
// files they replace; none may outlive the run.
function stagedLeftovers(f: Fixture): string[] {
  return [f.home, dirname(f.claudeFile), dirname(f.copilotFile)].flatMap((dir) =>
    readdirSync(dir).filter((name) => name.startsWith('.agent-inbox.') || name.startsWith('.agent-inbox-mcp.')))
}

// A user-scoped registration the installer did not write, beside an unrelated
// server, so an exact restore is distinguishable from a fresh registration.
function seedPriorRegistrations(f: Fixture): { claude: string; copilot: string } {
  const prior = (host: string): string => `${JSON.stringify({
    mcpServers: {
      'agent-inbox': { command: `/prior/${host}/node`, args: [`/prior/${host}/mcp-server.js`] },
      unrelated: { command: 'keep-me' },
    },
  }, null, 2)}\n`
  const claude = prior('claude')
  const copilot = prior('copilot')
  writeFileSync(f.env.CLAUDE_CONFIG!, claude)
  writeFileSync(f.env.COPILOT_CONFIG!, copilot)
  // The fake host CLIs report a user registration while its state file exists.
  writeFileSync(join(f.state, 'claude'), '')
  writeFileSync(join(f.state, 'copilot'), '')
  return { claude, copilot }
}

interface RunningInstaller {
  child: ChildProcess
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  stderr: () => string
}

// Spawned the way electron/setup-process.cjs runs Setup: /bin/bash leading
// its own process group, with stdout and stderr piped back to the parent.
function startInstaller(f: Fixture, args: string[]): RunningInstaller {
  const child = spawn('/bin/bash', [SCRIPT, ...args], {
    detached: true,
    env: f.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stdout!.resume()
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => { stderr += chunk })
  // 'close', not 'exit': it also waits until everything written to stderr has
  // been read.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  return { child, exited, stderr: () => stderr }
}

// What a crashed or force-quit app leaves its installer: nobody reads the pipes
// any more, so the installer's next write raises SIGPIPE.
async function closeParentPipes(child: ChildProcess): Promise<void> {
  await Promise.all([child.stdout!, child.stderr!].map((stream) =>
    new Promise<void>((resolveClose) => {
      stream.once('close', () => resolveClose())
      stream.destroy()
    })))
}

// Lets every paused fake (host CLI, mv or mktemp) finish.
function release(f: Fixture): void {
  for (const name of ['claude', 'copilot', 'mv', 'mktemp']) writeFileSync(join(f.state, `${name}.release`), '')
}

// Never leaves a paused fake or a live installer behind a failed assertion.
function stopInstaller(f: Fixture, installer: RunningInstaller): void {
  release(f)
  if (installer.child.exitCode === null && installer.child.signalCode === null) {
    try {
      process.kill(-installer.child.pid!, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

type Exit = { code: number | null; signal: NodeJS.Signals | null }

const ISOLATE = join(REPO, 'scripts', 'run-isolated.mjs')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

// Claude Code and Copilot CLI are Node programs, and Node resets every
// inherited ignored signal except PIPE and XFSZ to its default at startup, so
// the rollback's `trap ''` cannot protect them. This fake Claude CLI runs on
// Node and, asked to remove, records its pid and pauses BEFORE removing
// anything until it is released.
function useNodeClaudeCli(f: Fixture): void {
  const cli = join(f.home, 'claude-cli.cjs')
  writeFileSync(cli, [
    "const fs = require('node:fs')",
    'const args = process.argv.slice(2)',
    "const state = process.env.INSTALL_STATE + '/claude'",
    'const config = process.env.CLAUDE_CONFIG',
    "fs.appendFileSync(process.env.INSTALL_LOG, 'claude ' + args.join(' ') + '\\n')",
    "const verb = args.slice(0, 2).join(' ')",
    "if (verb === 'mcp get') {",
    '  if (!fs.existsSync(state)) process.exit(1)',
    "  console.log('  Scope: User config (available in all your projects)')",
    "} else if (verb === 'mcp add') {",
    "  fs.writeFileSync(state, '')",
    "  fs.writeFileSync(config, JSON.stringify({ mcpServers: { 'agent-inbox': { command: args.join(' ') } } }) + '\\n')",
    "} else if (verb === 'mcp remove') {",
    "  fs.writeFileSync(state + '.removing', String(process.pid))",
    '  setInterval(() => {',
    "    if (!fs.existsSync(state + '.release')) return",
    '    fs.rmSync(state, { force: true })',
    `    fs.writeFileSync(config, '{"mcpServers":{}}\\n')`,
    '    process.exit(0)',
    '  }, 20)',
    '} else process.exit(2)',
    '',
  ].join('\n'))
  writeFileSync(join(f.fakebin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`)
  chmodSync(join(f.fakebin, 'claude'), 0o755)
}

describe('agent setup installer', () => {
  it('is a dry run by default and changes neither instructions nor MCP config', () => {
    const f = fixture()
    const claudeBefore = readFileSync(f.claudeFile, 'utf8')
    const copilotBefore = readFileSync(f.copilotFile, 'utf8')

    const result = run(f)

    expect(result.code).toBe(0)
    expect(result.err).toMatch(/dry run/i)
    expect(result.out).toContain('claude mcp add --scope user agent-inbox')
    expect(result.out).toContain('copilot mcp add agent-inbox')
    expect(result.out).toContain('One ask, one surface')
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(copilotBefore)
    expect(existsSync(f.log)).toBe(false)
    expect(existsSync(join(f.state, 'selftest-ran'))).toBe(false)
    expect(workDirs(f)).toEqual([])
  })

  it('--apply registers both MCP clients and installs distinct managed instruction blocks', () => {
    const f = fixture()
    const result = run(f, ['--apply'])

    expect(result.code, result.err).toBe(0)
    const claude = readFileSync(f.claudeFile, 'utf8')
    const copilot = readFileSync(f.copilotFile, 'utf8')
    expect(claude).toContain('Keep this.')
    expect(copilot).toContain('Keep this too.')
    expect(claude).toContain(BEGIN)
    expect(copilot).toContain(BEGIN)
    expect(claude).toContain('Claude Code wake behavior')
    expect(claude).not.toContain('Copilot CLI wake behavior')
    expect(copilot).toContain('Copilot CLI wake behavior')
    expect(copilot).not.toContain('Claude Code wake behavior')
    expect(claude).toContain('One ask, one surface')
    expect(copilot).toContain('One ask, one surface')
    expect(claude).not.toContain('also raise a `flag')
    expect(copilot).not.toContain('also raise a `flag')
    const calls = readFileSync(f.log, 'utf8')
    expect(calls).toContain(`claude mcp add --scope user agent-inbox -- ${process.execPath}`)
    expect(calls).toContain(`copilot mcp add agent-inbox -- ${process.execPath}`)
    expect(readdirSync(dirname(f.claudeFile)).some((name) => name.startsWith('CLAUDE.md.bak.'))).toBe(true)
    expect(readdirSync(dirname(f.copilotFile)).some((name) => name.startsWith('copilot-instructions.md.bak.'))).toBe(true)
  })

  it('is idempotent: a second apply replaces its block and does not re-register either MCP', () => {
    const f = fixture()
    expect(run(f, ['--apply']).code).toBe(0)
    writeFileSync(f.log, '')

    const result = run(f, ['--apply'])

    expect(result.code, result.err).toBe(0)
    expect(count(readFileSync(f.claudeFile, 'utf8'), BEGIN)).toBe(1)
    expect(count(readFileSync(f.copilotFile, 'utf8'), BEGIN)).toBe(1)
    const calls = readFileSync(f.log, 'utf8')
    expect(calls).toContain('claude mcp get agent-inbox')
    expect(calls).toContain('copilot mcp get agent-inbox')
    expect(calls).not.toContain('mcp add')
  })

  it('--force replaces existing registrations without touching unrelated instructions', () => {
    const f = fixture()
    expect(run(f, ['--apply']).code).toBe(0)
    writeFileSync(f.log, '')

    const result = run(f, ['--apply', '--force', '--target', 'copilot'])

    expect(result.code, result.err).toBe(0)
    const calls = readFileSync(f.log, 'utf8')
    expect(calls).toContain('copilot mcp remove agent-inbox')
    expect(calls).toContain('copilot mcp add agent-inbox')
    expect(calls).not.toContain('claude ')
    expect(readFileSync(f.copilotFile, 'utf8')).toContain('Keep this too.')
    // The replaced registration's snapshot is not kept once the install commits.
    expect(workDirs(f)).toEqual([])
  })

  it('--uninstall removes only managed content and the selected MCP registration', () => {
    const f = fixture()
    expect(run(f, ['--apply']).code).toBe(0)
    writeFileSync(f.log, '')

    const result = run(f, ['--apply', '--uninstall', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    expect(readFileSync(f.claudeFile, 'utf8')).toBe('# Claude personal rules\n\nKeep this.\n')
    expect(readFileSync(f.copilotFile, 'utf8')).toContain(BEGIN)
    const calls = readFileSync(f.log, 'utf8')
    expect(calls).toContain('claude mcp remove --scope user agent-inbox')
    expect(calls).not.toContain('copilot ')
  })

  it('refuses to overwrite a file with unmatched managed markers', () => {
    const f = fixture()
    writeFileSync(f.copilotFile, `personal\n${BEGIN}\nbroken\n`)

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code).not.toBe(0)
    expect(result.err).toMatch(/unmatched managed markers/i)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(`personal\n${BEGIN}\nbroken\n`)
  })

  it('refuses reversed markers before invoking either host CLI', () => {
    const f = fixture()
    writeFileSync(f.copilotFile, `personal\n<!-- agent-inbox:end -->\nkeep\n${BEGIN}\nbroken\n`)

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code).not.toBe(0)
    expect(result.err).toMatch(/unmatched managed markers/i)
    expect(existsSync(f.log)).toBe(false)
    expect(readFileSync(f.copilotFile, 'utf8')).toContain('keep')
  })

  it('fails honestly on MCP registration errors and leaves instructions untouched', () => {
    const f = fixture()
    const before = readFileSync(f.copilotFile, 'utf8')
    f.env.FAIL_ADD = 'copilot'

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code).not.toBe(0)
    expect(result.err).toMatch(/could not register/i)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(before)
    // The add registered nothing, so the host refusing to remove it is not a
    // failed rollback: no warning, and no report or work directory left behind.
    expect(result.err).not.toMatch(/could not roll back|report retained/)
    expect(workDirs(f)).toEqual([])
  })

  it('does not delete an existing registration when the CLI probe fails', () => {
    const f = fixture()
    expect(run(f, ['--apply', '--target', 'copilot']).code).toBe(0)
    const configBefore = readFileSync(f.env.COPILOT_CONFIG!, 'utf8')
    writeFileSync(f.log, '')
    f.env.FAIL_GET = 'copilot'

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code, result.err).toBe(0)
    expect(readFileSync(f.env.COPILOT_CONFIG!, 'utf8')).toBe(configBefore)
    const calls = readFileSync(f.log, 'utf8')
    expect(calls).not.toContain('copilot mcp add')
    expect(calls).not.toContain('copilot mcp remove')
  })

  it('refuses an unreadable registration state without changing instructions', () => {
    const f = fixture()
    const before = readFileSync(f.copilotFile, 'utf8')
    writeFileSync(f.env.COPILOT_CONFIG!, '{ not json')
    f.env.FAIL_GET = 'copilot'

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code).not.toBe(0)
    expect(result.err).toMatch(/could not determine/i)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(before)
    const calls = readFileSync(f.log, 'utf8')
    expect(calls).not.toContain('copilot mcp add')
    expect(calls).not.toContain('copilot mcp remove')
  })

  it('rolls back MCP registrations added earlier in the same failed run', () => {
    const f = fixture()
    const claudeBefore = readFileSync(f.claudeFile, 'utf8')
    const copilotBefore = readFileSync(f.copilotFile, 'utf8')
    f.env.FAIL_ADD = 'copilot'

    const result = run(f, ['--apply'])

    expect(result.code).not.toBe(0)
    expect(existsSync(join(f.state, 'claude'))).toBe(false)
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(copilotBefore)
    expect(readFileSync(f.log, 'utf8')).toContain('claude mcp remove --scope user agent-inbox')
  })

  it('rolls back an active transaction when the process is terminated', async () => {
    const f = fixture()
    const claudeBefore = readFileSync(f.claudeFile, 'utf8')
    const copilotBefore = readFileSync(f.copilotFile, 'utf8')
    f.env.HANG_ADD = 'copilot'
    const child = spawn('bash', [SCRIPT, '--apply'], {
      detached: true,
      env: f.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    await waitFor(join(f.state, 'copilot.hanging'))

    process.kill(-child.pid!, 'SIGTERM')
    const code = await new Promise<number | null>((resolveCode) => child.on('close', resolveCode))

    expect(code).toBe(143)
    expect(stderr).toMatch(/interrupted.+restoring/i)
    expect(existsSync(join(f.state, 'claude'))).toBe(false)
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(copilotBefore)
  })

  it('serializes separate installer processes across the full transaction', async () => {
    const f = fixture()
    f.env.HANG_ADD = 'claude'
    const first = spawn('bash', [SCRIPT, '--apply', '--target', 'claude'], {
      detached: true,
      env: f.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitFor(join(f.state, 'claude.hanging'))
    const lock = join(f.home, '.agent-inbox', 'install-agents.lock')
    expect(lstatSync(lock).isFile()).toBe(true)
    writeFileSync(f.log, '')

    const second = run(f, ['--apply', '--target', 'copilot'])

    expect(second.code).not.toBe(0)
    expect(second.err).toMatch(/another setup is already running/i)
    expect(existsSync(f.log)).toBe(true)
    expect(readFileSync(f.log, 'utf8')).toBe('')
    const hooks = spawnSync('bash', [HOOK_SCRIPT, '--apply', '--uninstall'], {
      encoding: 'utf8',
      env: f.env,
    })
    expect(hooks.status).not.toBe(0)
    expect(hooks.stderr).toMatch(/install-hooks: another setup is already running/i)
    expect(existsSync(join(f.home, '.claude', 'settings.json'))).toBe(false)
    process.kill(-first.pid!, 'SIGTERM')
    await new Promise<number | null>((resolveCode) => first.on('close', resolveCode))
  })

  it('does not mistake an unlocked persistent lock file for ownership', () => {
    const f = fixture()
    const lock = join(f.home, '.agent-inbox', 'install-agents.lock')
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, 'left by a crashed process\n')

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code, result.err).toBe(0)
    expect(lstatSync(lock).isFile()).toBe(true)
  })

  it('releases the kernel lock when an installer process group crashes', async () => {
    const f = fixture()
    f.env.HANG_ADD = 'claude'
    const first = spawn('bash', [SCRIPT, '--apply', '--target', 'claude'], {
      detached: true,
      env: f.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitFor(join(f.state, 'claude.hanging'))
    const mutatorPid = Number(readFileSync(join(f.state, 'claude.hanging-pid'), 'utf8').trim())
    process.kill(-first.pid!, 'SIGKILL')
    await new Promise<number | null>((resolveCode) => first.on('close', resolveCode))
    await waitForGone(mutatorPid)
    delete f.env.HANG_ADD

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code, result.err).toBe(0)
  })

  it('rolls back when termination lands after an MCP write but before its command returns', async () => {
    const f = fixture()
    const before = readFileSync(f.copilotFile, 'utf8')
    f.env.MUTATE_THEN_HANG_ADD = 'copilot'
    const child = spawn('bash', [SCRIPT, '--apply', '--target', 'copilot'], {
      detached: true,
      env: f.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitFor(join(f.state, 'copilot.mutated'))

    process.kill(-child.pid!, 'SIGTERM')
    await new Promise<number | null>((resolveCode) => child.on('close', resolveCode))

    expect(existsSync(join(f.state, 'copilot'))).toBe(false)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(f.env.COPILOT_CONFIG!, 'utf8')).mcpServers).toEqual({})
  })

  it('fails honestly on MCP removal errors and keeps its instruction block', () => {
    const f = fixture()
    expect(run(f, ['--apply', '--target', 'copilot']).code).toBe(0)
    f.env.FAIL_REMOVE = 'copilot'

    const result = run(f, ['--apply', '--uninstall', '--target', 'copilot'])

    expect(result.code).not.toBe(0)
    expect(result.err).toMatch(/could not remove/i)
    expect(readFileSync(f.copilotFile, 'utf8')).toContain(BEGIN)
  })

  it('restores a force-removed registration when replacement fails', () => {
    const f = fixture()
    expect(run(f, ['--apply', '--target', 'copilot']).code).toBe(0)
    const originalConfig = readFileSync(f.env.COPILOT_CONFIG!, 'utf8')
    writeFileSync(f.log, '')
    f.env.FAIL_ADD_ONCE = 'copilot'

    const result = run(f, ['--apply', '--force', '--target', 'copilot'])

    expect(result.code).not.toBe(0)
    expect(readFileSync(f.env.COPILOT_CONFIG!, 'utf8')).toBe(originalConfig)
    const calls = readFileSync(f.log, 'utf8')
    expect(count(calls, 'copilot mcp add agent-inbox')).toBe(1)
    expect(result.err).toMatch(/restored exact MCP configuration/i)
  })

  it('restores earlier uninstall removals when a later host fails', () => {
    const f = fixture()
    expect(run(f, ['--apply']).code).toBe(0)
    const claudeBefore = readFileSync(f.claudeFile, 'utf8')
    const copilotBefore = readFileSync(f.copilotFile, 'utf8')
    const claudeConfigBefore = readFileSync(f.env.CLAUDE_CONFIG!, 'utf8')
    const copilotConfigBefore = readFileSync(f.env.COPILOT_CONFIG!, 'utf8')
    f.env.FAIL_REMOVE = 'copilot'

    const result = run(f, ['--apply', '--uninstall'])

    expect(result.code).not.toBe(0)
    expect(readFileSync(f.env.CLAUDE_CONFIG!, 'utf8')).toBe(claudeConfigBefore)
    expect(readFileSync(f.env.COPILOT_CONFIG!, 'utf8')).toBe(copilotConfigBefore)
    expect(existsSync(join(f.state, 'copilot'))).toBe(true)
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(copilotBefore)
  })

  it('does not touch MCP state when staging instruction content fails', () => {
    const f = fixture()
    const fakeCat = join(f.fakebin, 'cat')
    writeFileSync(fakeCat, `#!/bin/sh
case "\${1:-}" in
  *.rendered) test "\${FAIL_STAGE_CAT:-}" != 1 || exit 9 ;;
esac
exec /bin/cat "$@"
`)
    chmodSync(fakeCat, 0o755)
    const before = readFileSync(f.copilotFile, 'utf8')
    f.env.FAIL_STAGE_CAT = '1'

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code).not.toBe(0)
    expect(result.err).toMatch(/could not write staged instructions/i)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(before)
    expect(existsSync(f.log)).toBe(false)
  })

  it('stops before MCP changes when instruction rendering fails', () => {
    const f = fixture()
    const fakeCat = join(f.fakebin, 'cat')
    writeFileSync(fakeCat, `#!/bin/sh
case "\${1:-}" in
  *copilot-cli.md) exit 9 ;;
esac
exec /bin/cat "$@"
`)
    chmodSync(fakeCat, 0o755)

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code).not.toBe(0)
    expect(result.err).toMatch(/could not build/i)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe('# Copilot personal rules\n\nKeep this too.\n')
    expect(existsSync(f.log)).toBe(false)
  })

  it('rolls back MCP state when the final instruction replacement fails', () => {
    const f = fixture()
    const fakeMv = join(f.fakebin, 'mv')
    writeFileSync(fakeMv, `#!/bin/sh
last=""
for arg in "$@"; do last="$arg"; done
if [ "\${FAIL_MV_ONCE:-}" = 1 ] && [ "$last" = "$COPILOT_FILE" ] && [ ! -f "$INSTALL_STATE/mv-failed" ]; then
  touch "$INSTALL_STATE/mv-failed"
  exit 9
fi
exec /bin/mv "$@"
`)
    chmodSync(fakeMv, 0o755)
    const before = readFileSync(f.copilotFile, 'utf8')
    f.env.FAIL_MV_ONCE = '1'
    f.env.COPILOT_FILE = f.copilotFile

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code).not.toBe(0)
    expect(result.err).toMatch(/could not replace/i)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(before)
    expect(existsSync(join(f.state, 'copilot'))).toBe(false)
  })

  it('restores instructions when termination lands after rename but before it returns', async () => {
    const f = fixture()
    const fakeMv = join(f.fakebin, 'mv')
    writeFileSync(fakeMv, `#!/bin/sh
last=""
for arg in "$@"; do last="$arg"; done
if [ "\${MUTATE_THEN_HANG_MV:-}" = 1 ] && [ "$last" = "$COPILOT_FILE" ] && [ ! -f "$INSTALL_STATE/mv-mutated" ]; then
  /bin/mv "$@"
  touch "$INSTALL_STATE/mv-mutated"
  trap 'exit 143' TERM INT
  while :; do sleep 1; done
fi
exec /bin/mv "$@"
`)
    chmodSync(fakeMv, 0o755)
    const before = readFileSync(f.copilotFile, 'utf8')
    f.env.MUTATE_THEN_HANG_MV = '1'
    f.env.COPILOT_FILE = f.copilotFile
    const child = spawn('bash', [SCRIPT, '--apply', '--target', 'copilot'], {
      detached: true,
      env: f.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitFor(join(f.state, 'mv-mutated'))

    process.kill(-child.pid!, 'SIGTERM')
    await new Promise<number | null>((resolveCode) => child.on('close', resolveCode))

    expect(readFileSync(f.copilotFile, 'utf8')).toBe(before)
    expect(existsSync(join(f.state, 'copilot'))).toBe(false)
  })

  it('can remove its instruction block after the host CLI has been uninstalled', () => {
    const f = fixture()
    expect(run(f, ['--apply', '--target', 'copilot']).code).toBe(0)
    const copilot = join(f.fakebin, 'copilot')
    rmSync(copilot)

    const result = run(f, ['--apply', '--uninstall', '--target', 'copilot'])

    expect(result.code, result.err).toBe(0)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe('# Copilot personal rules\n\nKeep this too.\n')
    expect(result.err).toMatch(/CLI is unavailable/i)
  })

  it('rejects a runnable non-Node-24 binary even when its selftest would pass', () => {
    const f = fixture()
    const badNode = join(f.home, 'node26')
    writeFileSync(badNode, `#!/bin/sh
if [ "$1" = "-p" ]; then echo 26; exit 0; fi
exec "${process.execPath}" "$@"
`)
    chmodSync(badNode, 0o755)
    f.env.AGENT_INBOX_NODE = badNode

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code).not.toBe(0)
    expect(result.err).toMatch(/Node 24/)
    expect(readFileSync(f.copilotFile, 'utf8')).not.toContain(BEGIN)
  })

  it('does not mistake a workspace/plugin registration for the user entry it manages', () => {
    const f = fixture()
    writeFileSync(join(f.state, 'copilot'), '')
    f.env.COPILOT_SCOPE = 'workspace'

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code, result.err).toBe(0)
    const calls = readFileSync(f.log, 'utf8')
    expect(calls).toContain('copilot mcp get agent-inbox --json')
    expect(calls).toContain('copilot mcp add agent-inbox')
    expect(calls).not.toContain('copilot mcp remove')
  })

  it('never overwrites a same-second backup', () => {
    const f = fixture()
    const fakeDate = join(f.fakebin, 'date')
    writeFileSync(fakeDate, '#!/bin/sh\necho 20260731130000\n')
    chmodSync(fakeDate, 0o755)

    expect(run(f, ['--apply', '--target', 'copilot']).code).toBe(0)
    const installed = readFileSync(f.copilotFile, 'utf8')
    writeFileSync(f.copilotFile, installed.replace('Copilot CLI wake behavior', 'stale wake behavior'))
    expect(run(f, ['--apply', '--target', 'copilot']).code).toBe(0)

    const backups = readdirSync(dirname(f.copilotFile)).filter((name) =>
      name.startsWith('copilot-instructions.md.bak.20260731130000.'))
    expect(backups).toHaveLength(2)
    expect(new Set(backups).size).toBe(2)
  })

  it('updates a symlink target without replacing the instruction symlink', () => {
    const f = fixture()
    const target = join(f.home, 'dotfiles', 'copilot-instructions.md')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '# Managed in dotfiles\n')
    rmSync(f.copilotFile)
    symlinkSync(target, f.copilotFile)

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code, result.err).toBe(0)
    expect(lstatSync(f.copilotFile).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('Copilot CLI wake behavior')
    expect(readdirSync(dirname(target)).some((name) =>
      name.startsWith('copilot-instructions.md.bak.'))).toBe(true)
  })

  it('writes one combined block when both host instruction paths share a file', () => {
    const f = fixture()
    const shared = shareInstructionFile(f)

    const result = run(f, ['--apply'])

    expect(result.code, result.err).toBe(0)
    expect(lstatSync(f.claudeFile).isSymbolicLink()).toBe(true)
    expect(lstatSync(f.copilotFile).isSymbolicLink()).toBe(true)
    const installed = readFileSync(shared, 'utf8')
    expect(installed).toContain('Keep this shared.')
    expect(count(installed, BEGIN)).toBe(1)
    expect(count(installed, END)).toBe(1)
    const block = managedBlock(installed)
    expect(count(block, SNIPPET_LINE)).toBe(1)
    expect(count(block, SNIPPET_HEADING)).toBe(1)
    expect(count(block, 'Claude Code wake behavior')).toBe(1)
    expect(count(block, 'Copilot CLI wake behavior')).toBe(1)
    expect(block).toContain('\n\n## Copilot CLI wake behavior')
    expect(block.indexOf('Claude Code wake behavior')).toBeLessThan(block.indexOf('Copilot CLI wake behavior'))

    const second = run(f, ['--apply'])

    expect(second.code, second.err).toBe(0)
    expect(readFileSync(shared, 'utf8')).toBe(installed)

    const uninstall = run(f, ['--apply', '--uninstall'])

    expect(uninstall.code, uninstall.err).toBe(0)
    expect(readFileSync(shared, 'utf8')).toBe('# Shared agent rules\n\nKeep this shared.\n')
  })

  it('still writes both appendices for a shared file when only copilot is targeted', () => {
    const f = fixture()
    const shared = shareInstructionFile(f)

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code, result.err).toBe(0)
    const block = managedBlock(readFileSync(shared, 'utf8'))
    expect(count(block, SNIPPET_LINE)).toBe(1)
    expect(count(block, 'Claude Code wake behavior')).toBe(1)
    expect(count(block, 'Copilot CLI wake behavior')).toBe(1)
    expect(block.indexOf('Claude Code wake behavior')).toBeLessThan(block.indexOf('Copilot CLI wake behavior'))
  })

  it('inlines the snippet for a shared file even when the claude path imports it', () => {
    const f = fixture()
    const shared = shareInstructionFile(f)
    writeFileSync(shared, `# Shared agent rules\n\n${IMPORT_LINE}\n`)

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code, result.err).toBe(0)
    const text = readFileSync(shared, 'utf8')
    expect(text).toContain(IMPORT_LINE)
    expect(text).toContain(SNIPPET_LINE)
    expect(text).toContain(SNIPPET_HEADING)
    expect(text).not.toContain('Not inlined here')
  })

  it('omits the inlined snippet from the claude block when that file imports the snippet itself', () => {
    const f = fixture()
    const personal = `# Claude personal rules\n\nImported here so they can never drift:\n\n${IMPORT_LINE}\n`
    writeFileSync(f.claudeFile, personal)

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    const claude = readFileSync(f.claudeFile, 'utf8')
    expect(claude).toContain(personal)
    expect(claude).toContain(BEGIN)
    expect(claude).toContain('Not inlined here')
    expect(claude).not.toContain(SNIPPET_LINE)
    expect(claude).not.toContain(SNIPPET_HEADING)
  })

  it('still writes the claude appendix inside an import-mode block', () => {
    const f = fixture()
    writeFileSync(f.claudeFile, `# Claude personal rules\n\n${IMPORT_LINE}\n`)

    expect(run(f, ['--apply', '--target', 'claude']).code).toBe(0)

    const block = managedBlock(readFileSync(f.claudeFile, 'utf8'))
    const appendix = readFileSync(join(REPO, 'docs', 'instructions', 'claude-code.md'), 'utf8')
    expect(block).toContain(appendix)
    expect(block).toContain('Claude Code wake behavior')
    expect(block).not.toContain('Copilot CLI wake behavior')
    expect(block).toContain('In Claude Code sessions only:')
    expect(block).toMatch(/Copilot CLI must follow its returned\s+`watch` launch contract\./)
  })

  it('inlines the snippet anyway when the file only names it in prose or a code span', () => {
    const f = fixture()
    writeFileSync(
      f.claudeFile,
      '# Claude personal rules\n\nI pasted docs/reporting-snippet.md by hand once.\n' +
        '`@docs/reporting-snippet.md` is the import form I keep forgetting.\n' +
        `Someday: ${IMPORT_LINE}, maybe.\n`,
    )

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    const claude = readFileSync(f.claudeFile, 'utf8')
    expect(claude).toContain(SNIPPET_LINE)
    expect(claude).toContain(SNIPPET_HEADING)
    expect(claude).not.toContain('Not inlined here')
    expect(result.err).not.toMatch(/already imports/)
  })

  it('accepts an absolute, ~ or relative directive that resolves to this snippet', () => {
    // Every spelling has to land on the REAL file, so each fixture puts one
    // there: `~` under the temp HOME, relative from the instruction file's own
    // directory (which is where Claude Code resolves a relative import from).
    const cases: { path: string; prepare: (f: Fixture) => void }[] = [
      { path: SNIPPET_PATH, prepare: () => {} },
      {
        path: '~/Development/agent-inbox/docs/reporting-snippet.md',
        prepare: (f) =>
          linkSnippet(join(f.home, 'Development', 'agent-inbox', 'docs', 'reporting-snippet.md')),
      },
      {
        // Deliberately a name the repo root does NOT have, so this can only
        // resolve from the instruction file's directory.
        path: './agent-inbox/reporting-snippet.md',
        prepare: (f) =>
          linkSnippet(join(dirname(f.claudeFile), 'agent-inbox', 'reporting-snippet.md')),
      },
    ]

    for (const { path, prepare } of cases) {
      const f = fixture()
      prepare(f)
      writeFileSync(f.claudeFile, `# Claude personal rules\n\n@${path}\n`)

      const result = run(f, ['--apply', '--target', 'claude'])

      expect(result.code, path).toBe(0)
      expect(result.err, path).toMatch(/already imports/)
      const claude = readFileSync(f.claudeFile, 'utf8')
      expect(claude, path).not.toContain(SNIPPET_LINE)
      expect(claude, path).toContain('Claude Code wake behavior')
    }
  })

  it('ignores a relative directive that only resolves from the process working directory', () => {
    const f = fixture()
    // The premise: this path DOES resolve from where the installer runs. It is
    // a non-import only because a relative import resolves from the directory
    // of the file that carries it — and that HOME has no docs/ at all.
    expect(process.cwd()).toBe(REPO)
    expect(existsSync(join(process.cwd(), 'docs', 'reporting-snippet.md'))).toBe(true)
    writeFileSync(f.claudeFile, '# Claude personal rules\n\n@./docs/reporting-snippet.md\n')

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    expect(result.err).not.toMatch(/already imports/)
    expect(readFileSync(f.claudeFile, 'utf8')).toContain(SNIPPET_LINE)
  })

  it('inlines the snippet when the only directive sits inside a fenced code block', () => {
    const f = fixture()
    writeFileSync(
      f.claudeFile,
      '# Claude personal rules\n\nThe import my team should add:\n\n' +
        `\`\`\`\n${IMPORT_LINE}\n\`\`\`\n`,
    )

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    const claude = readFileSync(f.claudeFile, 'utf8')
    expect(claude).toContain(SNIPPET_LINE)
    expect(claude).toContain(SNIPPET_HEADING)
    expect(claude).not.toContain('Not inlined here')
    expect(result.err).not.toMatch(/already imports/)
  })

  it('inlines the snippet when the only directive is indented into a code block', () => {
    for (const indent of ['    ', '\t']) {
      const f = fixture()
      const label = JSON.stringify(indent)
      writeFileSync(f.claudeFile, `# Claude personal rules\n\nLike this:\n\n${indent}${IMPORT_LINE}\n`)

      const result = run(f, ['--apply', '--target', 'claude'])

      expect(result.code, label).toBe(0)
      const claude = readFileSync(f.claudeFile, 'utf8')
      expect(claude, label).toContain(SNIPPET_LINE)
      expect(claude, label).toContain(SNIPPET_HEADING)
      expect(claude, label).not.toContain('Not inlined here')
      expect(result.err, label).not.toMatch(/already imports/)
    }
  })

  it('still detects a directive indented up to three spaces', () => {
    const f = fixture()
    writeFileSync(f.claudeFile, `# Claude personal rules\n\n   ${IMPORT_LINE}\n`)

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    expect(result.err).toMatch(/already imports/)
    expect(readFileSync(f.claudeFile, 'utf8')).not.toContain(SNIPPET_LINE)
  })

  it('still detects a directive written after a closed code fence', () => {
    const f = fixture()
    writeFileSync(
      f.claudeFile,
      '# Claude personal rules\n\n```sh\nnpm run install:agents -- --apply\n```\n\n' + `${IMPORT_LINE}\n`,
    )

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    expect(result.err).toMatch(/already imports/)
    expect(readFileSync(f.claudeFile, 'utf8')).not.toContain(SNIPPET_LINE)
  })

  it('inlines the snippet when the directive path does not resolve', () => {
    const f = fixture()
    writeFileSync(
      f.claudeFile,
      '# Claude personal rules\n\n@/nowhere/at/all/docs/reporting-snippet.md\n',
    )

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    const claude = readFileSync(f.claudeFile, 'utf8')
    expect(claude).toContain(SNIPPET_LINE)
    expect(claude).toContain(SNIPPET_HEADING)
    expect(claude).not.toContain('Not inlined here')
    expect(result.err).not.toMatch(/already imports/)
  })

  it('inlines the snippet when the directive resolves to a different file', () => {
    // Left: a path that merely ENDS in the snippet filename. Right: the exact
    // basename in someone else's checkout. Neither is this repo's snippet.
    for (const suffix of ['team-reporting-snippet.md', 'team/docs/reporting-snippet.md']) {
      const f = fixture()
      const other = join(f.home, suffix)
      mkdirSync(dirname(other), { recursive: true })
      writeFileSync(other, '# Somebody else’s reporting contract\n')
      writeFileSync(f.claudeFile, `# Claude personal rules\n\n@${other}\n`)

      const result = run(f, ['--apply', '--target', 'claude'])

      expect(result.code, suffix).toBe(0)
      const claude = readFileSync(f.claudeFile, 'utf8')
      expect(claude, suffix).toContain(SNIPPET_LINE)
      expect(claude, suffix).toContain(SNIPPET_HEADING)
      expect(claude, suffix).not.toContain('Not inlined here')
      expect(result.err, suffix).not.toMatch(/already imports/)
    }
  })

  it('inlines the snippet when the directive is a URL rather than a path', () => {
    const f = fixture()
    writeFileSync(
      f.claudeFile,
      '# Claude personal rules\n\n@https://example.com/docs/reporting-snippet.md\n',
    )

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    const claude = readFileSync(f.claudeFile, 'utf8')
    expect(claude).toContain(SNIPPET_LINE)
    expect(claude).toContain(SNIPPET_HEADING)
    expect(claude).not.toContain('Not inlined here')
    expect(result.err).not.toMatch(/already imports/)
  })

  it('detects a directive that reaches this snippet by a different spelling', () => {
    const f = fixture()
    const viaLink = join(f.home, 'dotfiles', 'checkout')
    mkdirSync(dirname(viaLink), { recursive: true })
    symlinkSync(REPO, viaLink)
    writeFileSync(
      f.claudeFile,
      `# Claude personal rules\n\n@${viaLink}/docs/../docs/reporting-snippet.md\n`,
    )

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    expect(result.err).toMatch(/already imports/)
    const claude = readFileSync(f.claudeFile, 'utf8')
    expect(claude).not.toContain(SNIPPET_LINE)
    expect(claude).toContain('Not inlined here')
  })

  it('does not let an import inside the managed block suppress the inlined snippet', () => {
    const f = fixture()
    writeFileSync(
      f.claudeFile,
      `# Claude personal rules\n\n${BEGIN}\n${IMPORT_LINE}\nstale managed content\n${END}\n`,
    )

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    const claude = readFileSync(f.claudeFile, 'utf8')
    expect(claude).toContain(SNIPPET_LINE)
    expect(claude).not.toContain('stale managed content')
    expect(claude).not.toContain(IMPORT_LINE)
    expect(count(claude, BEGIN)).toBe(1)
  })

  it('leaves an import-mode file byte-identical on a second apply, writing no second backup', () => {
    const f = fixture()
    writeFileSync(f.claudeFile, `# Claude personal rules\n\n${IMPORT_LINE}\n`)
    expect(run(f, ['--apply', '--target', 'claude']).code).toBe(0)
    const first = readFileSync(f.claudeFile, 'utf8')
    const backupsAfterFirst = backups(f.claudeFile).length

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(first)
    expect(count(first, BEGIN)).toBe(1)
    expect(backups(f.claudeFile).length).toBe(backupsAfterFirst)
  })

  it('sheds an already-inlined snippet on the next run once the human adds the import', () => {
    const f = fixture()
    expect(run(f, ['--apply', '--target', 'claude']).code).toBe(0)
    const inlined = readFileSync(f.claudeFile, 'utf8')
    expect(inlined).toContain(SNIPPET_LINE)
    writeFileSync(f.claudeFile, `${IMPORT_LINE}\n${inlined}`)

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    const claude = readFileSync(f.claudeFile, 'utf8')
    expect(claude).toContain(IMPORT_LINE)
    expect(claude).not.toContain(SNIPPET_LINE)
    expect(claude).toContain('Claude Code wake behavior')
    expect(count(claude, BEGIN)).toBe(1)
  })

  it('inlines the snippet again on the next run once the human deletes the import', () => {
    const f = fixture()
    writeFileSync(f.claudeFile, `# Claude personal rules\n\n${IMPORT_LINE}\n`)
    expect(run(f, ['--apply', '--target', 'claude']).code).toBe(0)
    const thin = readFileSync(f.claudeFile, 'utf8')
    expect(thin).not.toContain(SNIPPET_LINE)
    writeFileSync(f.claudeFile, thin.replace(`${IMPORT_LINE}\n`, ''))

    const result = run(f, ['--apply', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    const claude = readFileSync(f.claudeFile, 'utf8')
    expect(claude).toContain(SNIPPET_LINE)
    expect(claude).not.toContain('Not inlined here')
    expect(count(claude, BEGIN)).toBe(1)
  })

  it('--uninstall removes an import-mode block and leaves the human import line', () => {
    const f = fixture()
    const personal = `# Claude personal rules\n\n${IMPORT_LINE}\n`
    writeFileSync(f.claudeFile, personal)
    expect(run(f, ['--apply', '--target', 'claude']).code).toBe(0)
    expect(readFileSync(f.claudeFile, 'utf8')).toContain(BEGIN)

    const result = run(f, ['--apply', '--uninstall', '--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(personal)
  })

  it('dry run reports the detected import and previews a block with no inlined snippet', () => {
    const f = fixture()
    const personal = `# Claude personal rules\n\n${IMPORT_LINE}\n`
    writeFileSync(f.claudeFile, personal)

    const result = run(f, ['--target', 'claude'])

    expect(result.code, result.err).toBe(0)
    expect(result.err).toMatch(/already imports docs\/reporting-snippet\.md/)
    expect(result.err).toMatch(/skipping the inlined snippet/)
    expect(result.out).toContain('Claude Code wake behavior')
    expect(result.out).not.toContain(SNIPPET_LINE)
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(personal)
  })

  it('writes copilot begin + whole snippet + copilot appendix + end when nothing imports the snippet', () => {
    const f = fixture()
    const before = readFileSync(f.copilotFile, 'utf8')

    expect(run(f, ['--apply', '--target', 'copilot']).code).toBe(0)

    const snippet = readFileSync(SNIPPET_PATH, 'utf8').replace(/^# /, '## ')
    const appendix = readFileSync(join(REPO, 'docs', 'instructions', 'copilot-cli.md'), 'utf8')
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(`${before}${BEGIN}\n${snippet}\n${appendix}${END}\n`)
  })

  it('keeps inlining the snippet for copilot even when its file carries an import directive', () => {
    const f = fixture()
    writeFileSync(f.copilotFile, `# Copilot personal rules\n\n${IMPORT_LINE}\n`)

    const result = run(f, ['--apply', '--target', 'copilot'])

    expect(result.code, result.err).toBe(0)
    const copilot = readFileSync(f.copilotFile, 'utf8')
    expect(copilot).toContain(SNIPPET_LINE)
    expect(copilot).toContain(SNIPPET_HEADING)
    expect(copilot).not.toContain('Not inlined here')
    expect(result.err).not.toMatch(/already imports/)
  })

  it('atomically restores a symlinked host config target after force failure', () => {
    const f = fixture()
    const logicalConfig = f.env.COPILOT_CONFIG!
    const targetConfig = join(f.home, 'dotfiles', 'copilot-mcp.json')
    mkdirSync(dirname(targetConfig), { recursive: true })
    writeFileSync(targetConfig, '{"mcpServers":{}}\n')
    rmSync(logicalConfig)
    symlinkSync(targetConfig, logicalConfig)
    expect(run(f, ['--apply', '--target', 'copilot']).code).toBe(0)
    const originalConfig = readFileSync(targetConfig, 'utf8')
    f.env.FAIL_ADD_ONCE = 'copilot'

    const result = run(f, ['--apply', '--force', '--target', 'copilot'])

    expect(result.code).not.toBe(0)
    expect(lstatSync(logicalConfig).isSymbolicLink()).toBe(true)
    expect(readFileSync(targetConfig, 'utf8')).toBe(originalConfig)
  })
})

// issue #208. Electron Setup pipes the installer's stdout/stderr, so after an
// app crash or force quit its next write raises SIGPIPE; a closed terminal sends
// SIGHUP. Each must roll the transaction back the way SIGINT/SIGTERM do, and no
// exit may delete the only copy of a registration the installer already removed.
// Most cases pause the fake host CLI right after a `--force` removal, before the
// replacement is registered: the window the issue reproduced.
describe('agent setup installer: losing its parent mid-install (#208)', () => {
  async function interruptAfterRemoval(
    f: Fixture,
    args: string[],
    interrupt: (installer: RunningInstaller) => Promise<void> | void,
  ): Promise<{ exit: Exit; stderr: string }> {
    f.env.PAUSE_AFTER_REMOVE = 'copilot'
    const installer = startInstaller(f, args)
    try {
      await waitFor(join(f.state, 'copilot.removed'), 10_000)
      // The premise: the registration really is gone when the signal lands.
      expect(readFileSync(f.env.COPILOT_CONFIG!, 'utf8')).not.toContain('agent-inbox')
      await interrupt(installer)
      release(f)
      const exit = await installer.exited
      return { exit, stderr: installer.stderr() }
    } finally {
      stopInstaller(f, installer)
    }
  }

  it('restores the removed registration when the parent pipes close (SIGPIPE)', async () => {
    const f = fixture()
    const prior = seedPriorRegistrations(f)
    const claudeBefore = readFileSync(f.claudeFile, 'utf8')
    const copilotBefore = readFileSync(f.copilotFile, 'utf8')

    const { exit } = await interruptAfterRemoval(f, ['--apply', '--force'], (installer) =>
      closeParentPipes(installer.child))

    expect(readFileSync(f.env.COPILOT_CONFIG!, 'utf8')).toBe(prior.copilot)
    expect(readFileSync(f.env.CLAUDE_CONFIG!, 'utf8')).toBe(prior.claude)
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(copilotBefore)
    expect(stagedLeftovers(f)).toEqual([])
    // Restored, so the snapshot is no longer the only copy and is not kept.
    expect(workDirs(f)).toEqual([])
    expect(exit).toEqual({ code: 141, signal: null })
  })

  it('restores the removed registration when the terminal hangs up (SIGHUP)', async () => {
    const f = fixture()
    const prior = seedPriorRegistrations(f)
    const claudeBefore = readFileSync(f.claudeFile, 'utf8')
    const copilotBefore = readFileSync(f.copilotFile, 'utf8')

    const { exit } = await interruptAfterRemoval(f, ['--apply', '--force'], (installer) => {
      process.kill(installer.child.pid!, 'SIGHUP')
    })

    expect(readFileSync(f.env.COPILOT_CONFIG!, 'utf8')).toBe(prior.copilot)
    expect(readFileSync(f.env.CLAUDE_CONFIG!, 'utf8')).toBe(prior.claude)
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(copilotBefore)
    expect(stagedLeftovers(f)).toEqual([])
    expect(workDirs(f)).toEqual([])
    expect(exit).toEqual({ code: 129, signal: null })
  })

  it('finishes the rollback when a cancel arrives after the parent pipes closed (SIGTERM)', async () => {
    const f = fixture()
    const prior = seedPriorRegistrations(f)
    const claudeBefore = readFileSync(f.claudeFile, 'utf8')
    const copilotBefore = readFileSync(f.copilotFile, 'utf8')

    // Only the shell is signalled, so the paused host CLI returns normally and
    // the TERM handler provably reports into pipes nobody reads any more.
    const { exit } = await interruptAfterRemoval(f, ['--apply', '--force'], async (installer) => {
      await closeParentPipes(installer.child)
      process.kill(installer.child.pid!, 'SIGTERM')
    })

    expect(readFileSync(f.env.COPILOT_CONFIG!, 'utf8')).toBe(prior.copilot)
    expect(readFileSync(f.env.CLAUDE_CONFIG!, 'utf8')).toBe(prior.claude)
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(copilotBefore)
    expect(stagedLeftovers(f)).toEqual([])
    expect(workDirs(f)).toEqual([])
    expect(exit).toEqual({ code: 143, signal: null })
  })

  it('rolls back on every other trapped signal too, exiting 128 + its number', async () => {
    for (const signal of ['SIGINT', 'SIGQUIT', 'SIGALRM', 'SIGXCPU', 'SIGXFSZ'] as const) {
      const f = fixture()
      const prior = seedPriorRegistrations(f)

      const { exit } = await interruptAfterRemoval(f, ['--apply', '--force', '--target', 'copilot'], (installer) => {
        process.kill(installer.child.pid!, signal)
      })

      expect(readFileSync(f.env.COPILOT_CONFIG!, 'utf8'), signal).toBe(prior.copilot)
      expect(workDirs(f), signal).toEqual([])
      expect(exit, signal).toEqual({ code: 128 + constants.signals[signal], signal: null })
    }
  })

  it('ignores further signals in the shell mid-restore, so it never re-runs a rollback step', async () => {
    const f = fixture()
    const claudeBefore = readFileSync(f.claudeFile, 'utf8')
    const copilotBefore = readFileSync(f.copilotFile, 'utf8')
    // Claude is newly registered, Copilot's registration hangs, and the
    // rollback's own removal of Claude then pauses. These /bin/sh fakes inherit
    // the ignored signals; a Node host CLI does not (see the next test).
    f.env.HANG_ADD = 'copilot'
    f.env.PAUSE_AFTER_REMOVE = 'claude'
    const installer = startInstaller(f, ['--apply'])
    let exit: Exit
    try {
      await waitFor(join(f.state, 'copilot.hanging'), 10_000)
      process.kill(-installer.child.pid!, 'SIGTERM')
      await waitFor(join(f.state, 'claude.removed'), 10_000)
      // A second cancel and a hangup land on the whole group mid-restore.
      process.kill(-installer.child.pid!, 'SIGTERM')
      process.kill(-installer.child.pid!, 'SIGHUP')
      release(f)
      exit = await installer.exited
    } finally {
      stopInstaller(f, installer)
    }

    const calls = readFileSync(f.log, 'utf8')
    expect(count(calls, 'claude mcp remove')).toBe(1)
    expect(count(calls, 'copilot mcp remove')).toBe(1)
    expect(existsSync(join(f.state, 'claude'))).toBe(false)
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(copilotBefore)
    expect(workDirs(f)).toEqual([])
    expect(exit).toEqual({ code: 143, signal: null })
  })

  it('finishes undoing a new registration when repeat signals reach the group mid-restore (#211)', async () => {
    const f = fixture()
    useNodeClaudeCli(f)
    // Claude has no registration, so undoing its new one needs its CLI's
    // `mcp remove`. Copilot's prior registration is replaced, and restoring it
    // needs only cp and mv.
    const priorCopilot = seedPriorRegistrations(f).copilot
    rmSync(join(f.state, 'claude'))
    writeFileSync(f.env.CLAUDE_CONFIG!, '{"mcpServers":{}}\n')
    const claudeBefore = readFileSync(f.claudeFile, 'utf8')
    const copilotBefore = readFileSync(f.copilotFile, 'utf8')
    f.env.HANG_ADD = 'copilot'
    const installer = startInstaller(f, ['--apply', '--force'])
    let exit: Exit
    try {
      await waitFor(join(f.state, 'copilot.hanging'), 10_000)
      process.kill(-installer.child.pid!, 'SIGTERM')
      await waitFor(join(f.state, 'claude.removing'), 10_000)
      const cliPid = Number(readFileSync(join(f.state, 'claude.removing'), 'utf8'))
      // A second Ctrl-C, then Setup's cancel, reach the whole group before
      // Claude's CLI has removed anything.
      process.kill(-installer.child.pid!, 'SIGINT')
      process.kill(-installer.child.pid!, 'SIGTERM')
      await sleep(300)
      expect(alive(cliPid), 'the host CLI survives signals sent to the installer group').toBe(true)
      release(f)
      exit = await installer.exited
    } finally {
      stopInstaller(f, installer)
    }

    expect(exit).toEqual({ code: 143, signal: null })
    // Undone exactly once: no step was cut short and started over.
    expect(count(readFileSync(f.log, 'utf8'), 'claude mcp remove')).toBe(1)
    expect(readFileSync(f.env.CLAUDE_CONFIG!, 'utf8')).not.toContain('agent-inbox')
    expect(existsSync(join(f.state, 'claude'))).toBe(false)
    expect(installer.stderr()).toContain('claude: rolled back MCP registration from failed install')
    expect(installer.stderr()).not.toContain('could not roll back')
    expect(readFileSync(f.env.COPILOT_CONFIG!, 'utf8')).toBe(priorCopilot)
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(copilotBefore)
    expect(stagedLeftovers(f)).toEqual([])
    // Everything was put back, so neither the report nor its folder is kept.
    expect(workDirs(f)).toEqual([])
  })

  it('reports a host CLI whose undo outlives the step bound, and stops waiting for it (#211)', async () => {
    const f = fixture()
    // Claude registers, Copilot's add fails, and Claude's `mcp remove` then
    // hangs before removing anything.
    f.env.FAIL_ADD = 'copilot'
    f.env.HANG_REMOVE = 'claude'
    f.env.AGENT_INBOX_ROLLBACK_STEP_TIMEOUT_MS = '400'
    const started = Date.now()
    const installer = startInstaller(f, ['--apply'])
    let exit: Exit | 'still running'
    try {
      exit = await Promise.race([installer.exited, sleep(12_000).then(() => 'still running' as const)])
    } finally {
      stopInstaller(f, installer)
    }

    expect(exit).toEqual({ code: 1, signal: null })
    expect(Date.now() - started).toBeLessThan(12_000)
    // The hung CLI was stopped, and the registration it never removed is
    // reported, not claimed as rolled back.
    await waitForGone(Number(readFileSync(join(f.state, 'claude.remove-pid'), 'utf8')))
    expect(existsSync(join(f.state, 'claude'))).toBe(true)
    const warning = 'install-agents: warning: could not roll back claude MCP registration: ' +
      'its mcp remove did not finish within 400 ms'
    expect(installer.stderr()).toContain(warning)
    expect(installer.stderr()).not.toContain('could not roll back copilot')
    const work = workDirs(f)
    expect(work, 'the work directory holding the report').toHaveLength(1)
    expect(readdirSync(work[0]!)).toEqual(['report.log'])
    expect(readFileSync(join(work[0]!, 'report.log'), 'utf8')).toContain(warning)
    expect(installer.stderr()).toContain(`report retained at ${join(work[0]!, 'report.log')}`)
  })

  it('runs an undo again when a repeat signal stops its helper while Node is still starting (#211)', async () => {
    const f = fixture()
    // Holds the first two starts of run-isolated.mjs inside Node's startup:
    // Node has already reset the signals the shell ignores, and the helper has
    // not yet ignored them itself.
    const preload = join(f.home, 'slow-isolate-start.cjs')
    writeFileSync(preload, [
      "const fs = require('node:fs')",
      "if (/run-isolated\\.mjs$/.test(process.argv[1] || '')) {",
      "  const starts = fs.readdirSync(process.env.INSTALL_STATE).filter((name) => name.startsWith('isolate-start.')).length",
      "  fs.writeFileSync(process.env.INSTALL_STATE + '/isolate-start.' + starts, String(process.pid))",
      '  if (starts < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)',
      '}',
      '',
    ].join('\n'))
    f.env.NODE_OPTIONS = `--require ${preload}`
    f.env.FAIL_ADD = 'copilot'
    const installer = startInstaller(f, ['--apply'])
    let exit: Exit
    try {
      await waitFor(join(f.state, 'isolate-start.0'), 10_000)
      // A second Ctrl-C lands while the helper that undoes Claude is starting.
      process.kill(-installer.child.pid!, 'SIGINT')
      await waitFor(join(f.state, 'isolate-start.1'), 10_000)
      exit = await installer.exited
    } finally {
      stopInstaller(f, installer)
    }

    expect(exit).toEqual({ code: 1, signal: null })
    expect(count(readFileSync(f.log, 'utf8'), 'claude mcp remove')).toBe(1)
    expect(existsSync(join(f.state, 'claude'))).toBe(false)
    expect(installer.stderr()).toContain('claude: rolled back MCP registration from failed install')
    expect(installer.stderr()).not.toContain('could not roll back')
    expect(workDirs(f)).toEqual([])
  })

  it('lets an undo outlive a killed installer without holding its pipes, and keeps the lock until it ends (#211)', async () => {
    const f = fixture()
    useNodeClaudeCli(f)
    f.env.FAIL_ADD = 'copilot'
    const installer = startInstaller(f, ['--apply'])
    try {
      await waitFor(join(f.state, 'claude.removing'), 10_000)
      const cliPid = Number(readFileSync(join(f.state, 'claude.removing'), 'utf8'))
      // The shell dies first. Neither the helper still waiting in its group
      // nor the undo holds the pipes Setup reads, so Setup sees them close.
      process.kill(installer.child.pid!, 'SIGKILL')
      const closed = await Promise.race([installer.exited, sleep(3000).then(() => 'pipes still open' as const)])
      expect(closed).toEqual({ code: null, signal: 'SIGKILL' })
      // Then Setup's forced stop reaches the rest of the group.
      process.kill(-installer.child.pid!, 'SIGKILL')
      await sleep(200)
      expect(alive(cliPid), 'the undo keeps running').toBe(true)
      // The undo still holds the setup lock, so another install cannot race it.
      const second = run(f, ['--apply', '--target', 'copilot'])
      expect(second.code).toBe(1)
      expect(second.err).toContain('another setup is already running')
      release(f)
      await waitForGone(cliPid)
      expect(existsSync(join(f.state, 'claude'))).toBe(false)
    } finally {
      stopInstaller(f, installer)
    }
  })

  it('stops a hung undo at its bound after Setup force-kills the installer, which frees the lock (#211)', async () => {
    const f = fixture()
    f.env.FAIL_ADD = 'copilot'
    f.env.HANG_REMOVE = 'claude'
    f.env.AGENT_INBOX_ROLLBACK_STEP_TIMEOUT_MS = '1500'
    const installer = startInstaller(f, ['--apply'])
    try {
      await waitFor(join(f.state, 'claude.remove-pid'), 10_000)
      const hungPid = Number(readFileSync(join(f.state, 'claude.remove-pid'), 'utf8'))
      // Setup's forced stop: SIGKILL to the installer's whole process group.
      process.kill(-installer.child.pid!, 'SIGKILL')
      expect(await installer.exited).toEqual({ code: null, signal: 'SIGKILL' })
      // The hung undo still holds the lock, so another install cannot race it.
      const blocked = run(f, ['--apply', '--target', 'claude'])
      expect(blocked.code).toBe(1)
      expect(blocked.err).toContain('another setup is already running')
      // Its bound still applies: the hung CLI is stopped and the lock freed.
      const deadline = Date.now() + 10_000
      while (alive(hungPid) && Date.now() < deadline) await sleep(50)
      expect(alive(hungPid), 'the hung undo is stopped at its bound').toBe(false)
      await sleep(300)
      delete f.env.FAIL_ADD
      delete f.env.HANG_REMOVE
      const next = run(f, ['--apply', '--target', 'claude'])
      expect(next.err).not.toContain('another setup is already running')
      expect(next.code).toBe(0)
    } finally {
      stopInstaller(f, installer)
    }
  }, 30_000)

  it('keeps the report when it cannot undo a registration it did add', () => {
    // Claude is registered, Copilot's add then fails, and removing Claude
    // again fails too. The re-check that follows either still finds Claude's
    // registration or cannot tell at all; both count as not undone. Copilot
    // never registered, so it has nothing to undo.
    for (const recheck of ['finds it', 'cannot tell'] as const) {
      const f = fixture()
      f.env.FAIL_ADD = 'copilot'
      f.env.FAIL_REMOVE = 'claude'
      if (recheck === 'cannot tell') {
        f.env.FAIL_GET = 'claude'
        f.env.CORRUPT_CONFIG_ON_ADD = 'claude'
      }

      const result = run(f, ['--apply'])

      expect(result.code, recheck).toBe(1)
      expect(existsSync(join(f.state, 'claude')), recheck).toBe(true)
      expect(result.err, recheck).toContain('install-agents: warning: could not roll back claude MCP registration')
      expect(result.err, recheck).not.toContain('could not roll back copilot')
      const work = workDirs(f)
      expect(work, `${recheck}: the work directory holding the report`).toHaveLength(1)
      expect(readdirSync(work[0]!), recheck).toEqual(['report.log'])
      expect(readFileSync(join(work[0]!, 'report.log'), 'utf8'), recheck)
        .toContain('install-agents: warning: could not roll back claude MCP registration')
      expect(result.err, recheck).toContain(`report retained at ${join(work[0]!, 'report.log')}`)
    }
  })

  it('removes a staged instruction copy when staging fails after the reader is gone', async () => {
    const f = fixture()
    const claudeBefore = readFileSync(f.claudeFile, 'utf8')
    const copilotBefore = readFileSync(f.copilotFile, 'utf8')
    // Claude's copy is staged; Copilot's staging then fails once nobody reads,
    // before any transaction exists, so cleanup alone must find Claude's copy.
    const fakeMktemp = join(f.fakebin, 'mktemp')
    writeFileSync(fakeMktemp, `#!/bin/sh
for arg in "$@"; do last="$arg"; done
case "$last" in
  */.agent-inbox.copilot.*)
    touch "$INSTALL_STATE/mktemp.paused"
    while [ ! -f "$INSTALL_STATE/mktemp.release" ]; do sleep 0.05; done
    exit 1 ;;
esac
exec /usr/bin/mktemp "$@"
`)
    chmodSync(fakeMktemp, 0o755)
    const installer = startInstaller(f, ['--apply'])
    let exit: Exit
    try {
      await waitFor(join(f.state, 'mktemp.paused'), 10_000)
      expect(stagedLeftovers(f)).toHaveLength(1)
      await closeParentPipes(installer.child)
      release(f)
      exit = await installer.exited
    } finally {
      stopInstaller(f, installer)
    }

    expect(stagedLeftovers(f)).toEqual([])
    expect(readFileSync(f.claudeFile, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(copilotBefore)
    expect(existsSync(f.log)).toBe(false)
    expect(workDirs(f)).toEqual([])
    expect(exit).toEqual({ code: 141, signal: null })
  })

  it('keeps the snapshot and its report when the restore itself fails after SIGPIPE', async () => {
    const f = fixture()
    const prior = seedPriorRegistrations(f)
    // A restore renames a temporary copy over the host config; fail only that.
    const fakeMv = join(f.fakebin, 'mv')
    writeFileSync(fakeMv, `#!/bin/sh
case "$(basename "$1")" in
  .agent-inbox-mcp.*) exit 9 ;;
esac
exec /bin/mv "$@"
`)
    chmodSync(fakeMv, 0o755)

    const { exit } = await interruptAfterRemoval(f, ['--apply', '--force', '--target', 'copilot'], (installer) =>
      closeParentPipes(installer.child))

    expect(readFileSync(f.env.COPILOT_CONFIG!, 'utf8')).toBe('{"mcpServers":{}}\n')
    const work = workDirs(f)
    expect(work, 'the work directory holding the snapshot').toHaveLength(1)
    const snapshot = join(work[0]!, 'copilot.mcp-config')
    expect(readFileSync(snapshot, 'utf8')).toBe(prior.copilot)
    expect(readFileSync(join(work[0]!, 'copilot.mcp-config-path'), 'utf8')).toBe(`${f.env.COPILOT_CONFIG}\n`)
    // Nobody could read the warning, so it stays beside the snapshot it names.
    expect(readFileSync(join(work[0]!, 'report.log'), 'utf8'))
      .toContain(`could not restore copilot MCP registration; recovery snapshot retained at ${snapshot}`)
    expect(stagedLeftovers(f)).toEqual([])
    expect(exit).toEqual({ code: 141, signal: null })
  })

  it('keeps every MCP snapshot when the shell dies mid-transaction from a signal it does not trap', async () => {
    const f = fixture()
    const prior = seedPriorRegistrations(f)

    // Bash still runs the EXIT trap for a fatal signal the script never
    // trapped, but no rollback runs: the snapshots are the only copies left.
    const { exit, stderr } = await interruptAfterRemoval(f, ['--apply', '--force'], (installer) => {
      process.kill(installer.child.pid!, 'SIGUSR1')
    })

    expect(exit).toEqual({ code: null, signal: 'SIGUSR1' })
    expect(readFileSync(f.env.COPILOT_CONFIG!, 'utf8')).toBe('{"mcpServers":{}}\n')
    const work = workDirs(f)
    expect(work, 'the work directory holding the snapshots').toHaveLength(1)
    expect(readFileSync(join(work[0]!, 'claude.mcp-config'), 'utf8')).toBe(prior.claude)
    expect(readFileSync(join(work[0]!, 'copilot.mcp-config'), 'utf8')).toBe(prior.copilot)
    expect(readFileSync(join(work[0]!, 'copilot.mcp-config-path'), 'utf8')).toBe(`${f.env.COPILOT_CONFIG}\n`)
    expect(stderr).toContain(`recovery snapshot retained at ${join(work[0]!, 'copilot.mcp-config')}`)
    expect(stagedLeftovers(f)).toEqual([])
  })

  it('restores published instructions and both registrations when the pipes close between instruction files', async () => {
    const f = fixture()
    const prior = seedPriorRegistrations(f)
    const claudeBefore = readFileSync(f.claudeFile, 'utf8')
    const copilotBefore = readFileSync(f.copilotFile, 'utf8')
    // Pause right after Claude's instructions are published, before Copilot's.
    const fakeMv = join(f.fakebin, 'mv')
    writeFileSync(fakeMv, `#!/bin/sh
last=""
for arg in "$@"; do last="$arg"; done
/bin/mv "$@" || exit
if [ "$last" = "$PAUSE_AFTER_MV" ] && [ ! -f "$INSTALL_STATE/mv.paused" ]; then
  touch "$INSTALL_STATE/mv.paused"
  while [ ! -f "$INSTALL_STATE/mv.release" ]; do sleep 0.05; done
fi
`)
    chmodSync(fakeMv, 0o755)
    f.env.PAUSE_AFTER_MV = f.claudeFile
    const installer = startInstaller(f, ['--apply', '--force'])
    let exit: Exit
    try {
      await waitFor(join(f.state, 'mv.paused'), 10_000)
      expect(readFileSync(f.claudeFile, 'utf8')).toContain(BEGIN)
      await closeParentPipes(installer.child)
      release(f)
      exit = await installer.exited
    } finally {
      stopInstaller(f, installer)
    }

    expect(readFileSync(f.claudeFile, 'utf8')).toBe(claudeBefore)
    expect(readFileSync(f.copilotFile, 'utf8')).toBe(copilotBefore)
    expect(readFileSync(f.env.CLAUDE_CONFIG!, 'utf8')).toBe(prior.claude)
    expect(readFileSync(f.env.COPILOT_CONFIG!, 'utf8')).toBe(prior.copilot)
    expect(stagedLeftovers(f)).toEqual([])
    expect(workDirs(f)).toEqual([])
    expect(exit).toEqual({ code: 141, signal: null })
  })
})

// scripts/run-isolated.mjs on its own: the helper the rollback runs its Node
// steps through.
describe('rollback step isolation (#211)', () => {
  function scratch(): string {
    return scratchDir('run-isolated-')
  }

  function isolate(args: string[]) {
    return spawnSync(process.execPath, [ISOLATE, ...args], { encoding: 'utf8', timeout: 20_000 })
  }

  // A Node command that records its pid, then exits 0 once released.
  function waitingCommand(dir: string): { args: string[]; pidFile: string; releaseFile: string } {
    const pidFile = join(dir, 'pid')
    const releaseFile = join(dir, 'release')
    const script = [
      "const fs = require('node:fs')",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      `setInterval(() => { if (fs.existsSync(${JSON.stringify(releaseFile)})) process.exit(0) }, 20)`,
    ].join('\n')
    return { args: [process.execPath, '-e', script], pidFile, releaseFile }
  }

  function exitOf(child: ChildProcess, event: 'exit' | 'close' = 'exit'): Promise<Exit> {
    return new Promise((resolveExit) => child.once(event, (code, signal) => resolveExit({ code, signal })))
  }

  it('relays the command\'s exit status, and its stdout only when asked to', () => {
    expect(isolate(['--', '/bin/sh', '-c', 'exit 7']).status).toBe(7)
    expect(isolate(['--', '/bin/sh', '-c', 'kill -TERM $$']).status).toBe(128 + constants.signals.SIGTERM)
    expect(isolate(['--', join(scratch(), 'no-such-command')]).status).toBe(127)
    expect(isolate(['--timeout-ms', '0', '--', '/bin/sh', '-c', 'exit 0']).status).toBe(125)

    const quiet = isolate(['--', '/bin/sh', '-c', 'echo out; echo err >&2'])
    expect([quiet.status, quiet.stdout, quiet.stderr]).toEqual([0, '', ''])
    const relayed = isolate(['--stdout', '--', '/bin/sh', '-c', 'printf "%s" "{\\"status\\":\\"ok\\"}"; echo err >&2'])
    expect([relayed.status, relayed.stdout, relayed.stderr]).toEqual([0, '{"status":"ok"}', ''])
  })

  it('stops a command that outlives its bound, with everything in its process group, and exits 124', async () => {
    const pids = join(scratch(), 'pids')
    const started = Date.now()
    // Both the command and its background child ignore SIGTERM, so only the
    // SIGKILL that follows can stop them.
    const result = isolate(['--timeout-ms', '300', '--', '/bin/sh', '-c',
      `trap '' TERM; sleep 60 & echo "$$ $!" > '${pids}'; while :; do sleep 0.1; done`])

    expect(result.status).toBe(124)
    expect(result.stderr).toContain('did not finish within 300 ms')
    expect(Date.now() - started).toBeLessThan(10_000)
    for (const pid of readFileSync(pids, 'utf8').trim().split(' ').map(Number)) await waitForGone(pid)
  })

  it('keeps waiting through signals sent to its process group, which never reach the command', async () => {
    const command = waitingCommand(scratch())
    // Leading its own group, like the installer it runs inside.
    const helper = spawn(process.execPath, [ISOLATE, '--', ...command.args], { detached: true, stdio: 'ignore' })
    const exit = exitOf(helper)
    try {
      await waitFor(command.pidFile, 10_000)
      const commandPid = Number(readFileSync(command.pidFile, 'utf8'))
      for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGALRM', 'SIGTERM', 'SIGXCPU'] as const) {
        process.kill(-helper.pid!, signal)
      }
      await sleep(300)
      expect(alive(commandPid)).toBe(true)
      expect([helper.exitCode, helper.signalCode]).toEqual([null, null])
      writeFileSync(command.releaseFile, '')
      expect(await exit).toEqual({ code: 0, signal: null })
    } finally {
      writeFileSync(command.releaseFile, '')
      try {
        process.kill(-helper.pid!, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  })

  it('never hands the command its own stdout or stderr, so a reader sees them close when it is killed', async () => {
    const command = waitingCommand(scratch())
    const helper = spawn(process.execPath, [ISOLATE, '--', ...command.args], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    helper.stdout!.resume()
    helper.stderr!.resume()
    const closed = exitOf(helper, 'close')
    try {
      await waitFor(command.pidFile, 10_000)
      const commandPid = Number(readFileSync(command.pidFile, 'utf8'))
      // Setup's forced stop: SIGKILL to the whole process group.
      process.kill(-helper.pid!, 'SIGKILL')
      expect(await Promise.race([closed, sleep(3000).then(() => 'pipes still open')]))
        .toEqual({ code: null, signal: 'SIGKILL' })
      expect(alive(commandPid)).toBe(true)
      writeFileSync(command.releaseFile, '')
      await waitForGone(commandPid)
    } finally {
      writeFileSync(command.releaseFile, '')
    }
  })

  it('still stops the command at its bound after it is killed itself', async () => {
    const command = waitingCommand(scratch())
    const helper = spawn(process.execPath, [ISOLATE, '--timeout-ms', '1000', '--', ...command.args], {
      detached: true,
      stdio: 'ignore',
    })
    try {
      await waitFor(command.pidFile, 10_000)
      const commandPid = Number(readFileSync(command.pidFile, 'utf8'))
      // Setup's forced stop kills the helper with the installer's group.
      process.kill(-helper.pid!, 'SIGKILL')
      await sleep(300)
      expect(alive(commandPid), 'the command outlives the helper').toBe(true)
      // The never-released command is stopped once its bound runs out.
      const deadline = Date.now() + 8000
      while (alive(commandPid) && Date.now() < deadline) await sleep(50)
      expect(alive(commandPid), 'the command is stopped at its bound').toBe(false)
    } finally {
      writeFileSync(command.releaseFile, '')
    }
  })
})
