// Issue #412, step 2: the `agent-inbox-driver` entry. It refuses to run without
// a TTY on stdin (approvals are answered there), takes only the step-2 modes,
// and its Stop is a lease the runtime CLI writes. No driver module may enter
// the stdio MCP server's or the viewer's import graph.
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { createLaunch, driverStopRequested, getLaunch, openDb, parkLaunch } from '../src/store.js'
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
    // --reasoning-effort takes only Copilot's own levels
    const badEffort = run(['copilot', '--cwd', '.', '--mode', 'ask', '--prompt-file', 'x', '--reasoning-effort', 'extreme'])
    expect(badEffort.status).toBe(64)
    expect(badEffort.stderr).toContain('--reasoning-effort must be one of none, minimal, low, medium, high, xhigh, max')
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

  it('stop <launch id> also asks an app launch’s driver to stop, and ends a parked launch at once (step 3)', () => {
    const dir = scratchDir('driver-cli-launch-')
    const path = join(dir, 'inbox.db')
    const parked = '11111111-2222-4333-8444-000000000002'
    const seed = openDb(path)
    for (const id of [LAUNCH, parked]) {
      createLaunch(seed, {
        id, host: 'copilot', project: 'p', stream: '', cwd: dir, mode: 'ask', budgetActiveMs: 60_000, budgetToolCalls: 1,
        prompt: 'x', specVersion: 1, driverPid: 1,
      })
    }
    parkLaunch(seed, parked, { acpSession: 'acp', activeMs: 0, toolCalls: 0 })
    seed.close()
    expect(run(['stop', LAUNCH], { AGENT_INBOX_DB: path }).status).toBe(0)
    expect(run(['stop', parked], { AGENT_INBOX_DB: path }).status).toBe(0)
    const db = openDb(path)
    try {
      expect(getLaunch(db, LAUNCH)!.stop_requested_at).not.toBeNull()
      expect(getLaunch(db, parked)).toMatchObject({ status: 'ended', end_reason: 'stopped' })
    } finally {
      db.close()
    }
  })

  it('run takes exactly a launch id and an absolute hub path, and writes nothing to stdout for a usage error', () => {
    for (const args of [['run'], ['run', LAUNCH], ['run', 'not-a-launch', '/x/inbox.db'], ['run', LAUNCH, 'relative.db'], ['run', LAUNCH, '/x/inbox.db', 'extra']]) {
      const result = run(args)
      expect(result.status, args.join(' ')).toBe(64)
      expect(result.stdout).toBe('')
    }
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
  const DRIVER = [
    'src/driver.ts', 'src/driver-cli.ts', 'src/driver-link.ts', 'src/driver-policy.ts', 'src/driver-tty.ts', 'src/acp-client.ts',
    'src/driver-launch.ts', 'src/launch-spec.ts', 'src/launch-sign.ts',
  ]

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

  // #435: a driver run from the app bundle keeps running after an update renames the bundle aside and
  // deletes it, because its whole graph is loaded at start. A late load would fail there, or read
  // another version's file from a bundle replaced in place, so no driver module loads one.
  it('loads its whole graph at start: no driver module uses a dynamic import() or require()', () => {
    const graph = [...closure('src/driver-cli.ts')]
    expect(graph).toEqual(expect.arrayContaining(['src/driver-pin.ts', 'scripts/runtime-pins.mjs', 'public/reserved-projects.js']))
    for (const file of graph) {
      expect(readFileSync(join(REPO, file), 'utf8'), file).not.toMatch(/\bimport\s*\(|\brequire\s*\(|\bcreateRequire\b/)
    }
  })
})
