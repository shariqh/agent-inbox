import {
  chmodSync,
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
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const REPO = resolve(import.meta.dirname, '..')
const SCRIPT = join(REPO, 'scripts', 'install-agents.sh')
const BEGIN = '<!-- agent-inbox:begin -->'
const END = '<!-- agent-inbox:end -->'
const SNIPPET_PATH = join(REPO, 'docs', 'reporting-snippet.md')
// The live import the owner keeps in ~/.claude/CLAUDE.md, verbatim in shape.
const IMPORT_LINE = `@${SNIPPET_PATH}`
// Two strings that exist ONLY in the shared snippet — neither host appendix
// contains them — so their presence/absence is exactly "was the snippet inlined".
const SNIPPET_LINE = 'One ask, one surface'
const SNIPPET_HEADING = '## Flags (one-shot attention)'

interface Fixture {
  home: string
  env: NodeJS.ProcessEnv
  claudeFile: string
  copilotFile: string
  log: string
  fakebin: string
  state: string
}

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'agent-installer-'))
  const fakebin = join(home, 'fakebin')
  const state = join(home, 'state')
  const log = join(home, 'cli.log')
  mkdirSync(fakebin)
  mkdirSync(state)

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
    if [ "\${MUTATE_THEN_HANG_ADD:-}" = "$name" ]; then
      touch "$INSTALL_STATE/$name"
      printf '{"mcpServers":{"agent-inbox":{"command":"partial"}}}\\n' > "$config"
      touch "$INSTALL_STATE/$name.mutated"
      trap 'exit 143' TERM INT
      while :; do sleep 1; done
    fi
    if [ "\${HANG_ADD:-}" = "$name" ]; then
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
    rm -f "$INSTALL_STATE/$name"
    printf '{"mcpServers":{}}\\n' > "$config"
    ;;
  *) exit 2 ;;
esac
`
  for (const name of ['claude', 'copilot']) {
    const path = join(fakebin, name)
    writeFileSync(path, cli)
    chmodSync(path, 0o755)
  }
  const lockCommand = spawnSync(
    '/bin/sh',
    ['-c', 'command -v lockf || command -v flock'],
    { encoding: 'utf8' },
  ).stdout.trim()
  if (!lockCommand) throw new Error('install-agents tests require lockf or flock')
  symlinkSync(lockCommand, join(fakebin, lockCommand.slice(lockCommand.lastIndexOf('/') + 1)))

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
    env: {
      ...process.env,
      HOME: home,
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

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
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

    expect(code).not.toBe(0)
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
    process.kill(-first.pid!, 'SIGKILL')
    await new Promise<number | null>((resolveCode) => first.on('close', resolveCode))
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
