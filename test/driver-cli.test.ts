// Issue #412, step 2: the `agent-inbox-driver` entry. It refuses to run without
// a TTY on stdin (approvals are answered there), takes only the step-2 modes,
// and its Stop is a lease the runtime CLI writes. No driver module may enter
// the stdio MCP server's or the viewer's import graph.
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { driverStopRequested, openDb } from '../src/store.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = new URL('..', import.meta.url).pathname
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const LAUNCH = '11111111-2222-4333-8444-555555555555'

afterEach(() => removeScratchDirs())

function run(args: string[], env: Record<string, string> = {}) {
  const dir = scratchDir('driver-cli-')
  const result = spawnSync(TSX, [join(REPO, 'src', 'driver-cli.ts'), ...args], {
    cwd: dir,
    // stdin is a pipe here, never a TTY
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_INBOX_DB: join(dir, 'inbox.db'), COPILOT_HOME: join(dir, 'copilot-home'), ...env },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { ...result, dir }
}

describe('agent-inbox-driver (#412 step 2)', () => {
  it('refuses to run without a TTY on stdin, before touching the hub or starting anything', () => {
    const dir = scratchDir('driver-cli-task-')
    const prompt = join(dir, 'task.txt')
    writeFileSync(prompt, 'Fix the failing test.')
    const db = join(dir, 'hub', 'inbox.db')
    const result = run(['copilot', '--cwd', dir, '--mode', 'ask', '--prompt-file', prompt], { AGENT_INBOX_DB: db })
    expect(result.status).toBe(2)
    expect(result.stderr).toBe('agent-inbox-driver: stdin is not a terminal: approvals are answered here, so the driver runs only in a terminal\n')
    expect(result.stdout).toBe('')
    expect(existsSync(db)).toBe(false)
  })

  it('takes only ask and read-only in step 2, and refuses unknown or repeated flags', () => {
    expect(run(['copilot', '--cwd', '.', '--mode', 'plan', '--prompt-file', 'x']).status).toBe(64)
    expect(run(['copilot', '--cwd', '.', '--mode', 'ask', '--prompt-file', 'x', '--yolo', '1']).status).toBe(64)
    expect(run(['copilot', '--cwd', '.', '--cwd', '.', '--mode', 'ask', '--prompt-file', 'x']).status).toBe(64)
    expect(run(['copilot', '--mode', 'ask', '--prompt-file', 'x']).status).toBe(64)
    expect(run(['nonsense']).status).toBe(64)
    expect(run(['--help']).status).toBe(0)
  })

  it('stop <launch id> writes the stop lease the driver polls', () => {
    const result = run(['stop', LAUNCH])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`Asked the driver of launch ${LAUNCH} to stop.\n`)
    const db = openDb(join(result.dir, 'inbox.db'))
    try {
      expect(driverStopRequested(db, LAUNCH)).toBe(true)
    } finally {
      db.close()
    }
    expect(run(['stop', 'not-a-launch']).status).toBe(64)
  })
})

describe('the driver stays out of the MCP server’s and the viewer’s graphs (§2)', () => {
  const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g
  const closure = (entry: string): Set<string> => {
    const seen = new Set<string>()
    const queue = [entry]
    while (queue.length) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const code = readFileSync(join(REPO, file), 'utf8')
      for (const match of code.matchAll(SPEC)) {
        const target = posix.normalize(posix.join(dirname(file), match[2]!))
        const ts = target.replace(/\.js$/, '.ts')
        queue.push(target.startsWith('src/') && existsSync(join(REPO, ts)) ? ts : target)
      }
    }
    return seen
  }
  const DRIVER = ['src/driver.ts', 'src/driver-cli.ts', 'src/driver-link.ts', 'src/driver-policy.ts', 'src/driver-tty.ts', 'src/acp-client.ts']

  it('no driver module is reachable from the stdio MCP server, the hook, the watcher or the viewer', () => {
    for (const entry of ['src/mcp-server.ts', 'src/hook-cli.ts', 'src/watch-cli.ts', 'src/viewer-server.ts']) {
      expect([...closure(entry)].filter((file) => DRIVER.includes(file)), entry).toEqual([])
    }
  })

  it('the driver reaches the hub only through store.ts, and no network or viewer module', () => {
    const graph = closure('src/driver-cli.ts')
    expect(DRIVER.every((file) => graph.has(file))).toBe(true)
    expect(graph.has('src/store.ts')).toBe(true)
    expect([...graph].filter((file) => /viewer|prstate|poller|mcp\.ts|channel/.test(file))).toEqual([])
    for (const file of DRIVER) {
      const code = readFileSync(join(REPO, file), 'utf8')
      expect(code, file).not.toMatch(/from 'node:(net|http|https|dgram|tls)'|\bfetch\(|\.prepare\(/)
    }
  })
})
