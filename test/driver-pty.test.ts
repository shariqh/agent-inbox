// Issue #412 review (round 2): closing the driver's terminal must still clean
// up. A REAL pseudo-terminal: Python's pty module (no native dependency) runs
// the driver CLI on a pty's slave end against a fake `copilot` on PATH, waits
// for the approval prompt, then closes the master end. The driver gets SIGHUP
// and every later write fails with EIO; it must still resolve the alert and
// release its lease in a scratch hub.
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { claimDriverSlot, listItems, openDb } from '../src/store.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = new URL('..', import.meta.url).pathname
const python = spawnSync('python3', ['-c', 'import pty, select'], { stdio: 'ignore' })
const ptyAvailable = python.status === 0 && (process.platform === 'darwin' || process.platform === 'linux')

afterEach(() => removeScratchDirs())

// A Copilot stand-in speaking just enough ACP: it starts in #agent with
// allow_all off, raises one shell permission request for any prompt, answers
// session/cancel, and exits when its stdin closes.
const FAKE_COPILOT = `#!/usr/bin/env node
const agent = 'https://agentclientprotocol.com/protocol/session-modes#agent'
const config = (mode) => [{ id: 'mode', currentValue: mode }, { id: 'allow_all', currentValue: 'off' }]
let prompt = null
let buffer = ''
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const update = (u) => send({ method: 'session/update', params: { sessionId: 's-1', update: u } })
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\\n'); end !== -1; end = buffer.indexOf('\\n')) {
    const m = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's-1', modes: { currentModeId: agent }, configOptions: config(agent) } })
    else if (m.method === 'session/set_mode') {
      update({ sessionUpdate: 'current_mode_update', currentModeId: m.params.modeId })
      update({ sessionUpdate: 'config_option_update', configOptions: config(m.params.modeId) })
      send({ id: m.id, result: {} })
    } else if (m.method === 'session/prompt') {
      prompt = m.id
      update({ sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'Run tests', kind: 'execute', rawInput: { command: 'npm test' } })
      send({ id: 900, method: 'session/request_permission', params: { sessionId: 's-1', toolCall: { toolCallId: 't-1', title: 'Run tests', kind: 'execute', rawInput: { command: 'npm test' } }, options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
      ] } })
    } else if (m.method === 'session/cancel' && prompt !== null) {
      send({ id: prompt, result: { stopReason: 'cancelled' } })
      prompt = null
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`

// Runs argv on a pty, waits for the approval prompt, closes the master end (the
// terminal window closing), then waits for the child and prints its exit code.
const HARNESS = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
seen = b''
deadline = time.time() + 40
while time.time() < deadline and b'[y/N]' not in seen:
    ready, _, _ = select.select([fd], [], [], 0.5)
    if ready:
        try:
            seen += os.read(fd, 4096)
        except OSError:
            break
os.close(fd)
status = None
end = time.time() + 40
while time.time() < end:
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        status = st
        break
    time.sleep(0.1)
sys.stdout.write(seen.decode('utf-8', 'replace'))
sys.stdout.write('\\nPROMPTED %s\\n' % (b'[y/N]' in seen))
sys.stdout.write('EXIT %s\\n' % (os.waitstatus_to_exitcode(status) if status is not None else 'timeout'))
`

describe('closing the driver’s terminal (#412 review, round 2)', () => {
  it.skipIf(!ptyAvailable)('a real pty hang-up resolves the open alert and releases the driver’s lease', () => {
    const dir = scratchDir('driver-pty-')
    const bin = join(dir, 'bin')
    const home = join(dir, 'copilot-home')
    const repo = join(dir, 'repo')
    for (const folder of [bin, home, repo, join(dir, 'hub')]) mkdirSync(folder)
    writeFileSync(join(bin, 'copilot'), FAKE_COPILOT)
    chmodSync(join(bin, 'copilot'), 0o755)
    writeFileSync(join(home, 'mcp-config.json'), JSON.stringify({ mcpServers: { 'agent-inbox': { command: 'node', args: ['mcp-server.js'] } } }))
    writeFileSync(join(dir, 'task.txt'), 'Run the tests.')
    writeFileSync(join(dir, 'harness.py'), HARNESS)
    const dbPath = join(dir, 'hub', 'inbox.db')
    const result = spawnSync('python3', [
      join(dir, 'harness.py'),
      process.execPath, '--import', 'tsx', join(REPO, 'src', 'driver-cli.ts'),
      'copilot', '--cwd', repo, '--mode', 'ask', '--prompt-file', join(dir, 'task.txt'),
    ], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        ...process.env,
        PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        COPILOT_HOME: home,
        AGENT_INBOX_DB: dbPath,
        AGENT_INBOX_DRIVER_LINK_WAIT_MS: '0',
      },
    })
    expect(result.stdout, result.stderr).toContain('PROMPTED True')
    // the driver exited on its own after a clean stop, not on an uncaught EIO
    expect(result.stdout).toMatch(/EXIT 0\n/)
    const db = openDb(dbPath)
    try {
      expect(listItems(db).filter((item) => item.project === '@sessions').map((item) => [item.status, item.outcome]))
        .toEqual([['resolved', 'Session stopped.']])
      // its driver: lease is gone, so a one-slot claim succeeds at once
      expect(claimDriverSlot(db, { launchId: '22222222-2222-4333-8444-555555555555', pid: 4243, nonce: 'next' }, 1)).toEqual({ ok: true })
    } finally {
      db.close()
    }
    const launch = readdirSync(join(dir, 'hub', 'launches'))[0]!
    const events = readFileSync(join(dir, 'hub', 'launches', launch, 'events.ndjson'), 'utf8')
    expect(events).toContain('"event":"ended","reason":"stopped"')
  }, 120_000)
})
