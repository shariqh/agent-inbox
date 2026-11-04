// Issue #412 step 3: `driver-cli.js run <launch id> <hub db>`, the detached
// driver Electron main starts (design §8), end to end against a fake `copilot`
// on the spec's PATH: the spec read from fd 3, the one stdout status line, the
// launch row it writes, Stop, park when idle, resume by session/load, a signed
// approval, and its refusals before anything starts.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import type Database from 'better-sqlite3'
import { claimDriverSlot, closeLostLaunch, getLaunch, handOffForTerminal, launchDriverAlive, listItems, openDb, recordLaunchProgress, replyItem, requestLaunchPark, requestLaunchStop } from '../src/store.js'
import { LAUNCH_KEY, sign } from './launch-fixtures.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = new URL('..', import.meta.url).pathname
const LAUNCH = '22222222-3333-4444-8555-666666666666'
const open: Database.Database[] = []

afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close()
  removeScratchDirs()
})

// A Copilot stand-in: new and load sessions in #agent with allow_all off, a
// prompt either ends at once or (FAKE_ASK) raises one permission request, and
// every message it reads is appended to FAKE_LOG.
// Its interpreter is `fakenode`, a script the test writes and owns that execs
// this Node: the driver resolves and trust-checks the interpreter (§8), and the
// machine's own Node may not pass that check (CI's tool cache is owned by
// another user), which is no business of these tests.
const FAKE_COPILOT = `#!/usr/bin/env fakenode
const fs = require('fs')
const agent = 'https://agentclientprotocol.com/protocol/session-modes#agent'
const config = (mode) => [{ id: 'mode', currentValue: mode }, { id: 'allow_all', currentValue: 'off' }]
// Node uses low fds of its own, so ask a shell it starts, as a tool call would:
// a descriptor copilot inherited is inherited again there
const fd3 = require('child_process').execFileSync('/bin/sh', ['-c', 'if [ -e /dev/fd/3 ]; then echo open; else echo closed; fi']).toString().trim()
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { hooks: process.env.AGENT_INBOX_HOOKS, db: process.env.AGENT_INBOX_DB }, fd3, cwd: process.cwd() }) + '\\n')
let buffer = ''
let prompt = null
let slow = false
// a tool's process left in copilot's group, which outlives copilot itself (step 5's handoff ends it)
if (process.env.FAKE_GROUP_SLEEPER) require('child_process').spawn('/bin/sleep', ['60'], { stdio: 'ignore' }).unref()
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const update = (u) => send({ method: 'session/update', params: { sessionId: 's-1', update: u } })
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\\n'); end !== -1; end = buffer.indexOf('\\n')) {
    const m = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + '\\n')
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
    else if (m.method === 'session/load' && process.env.FAKE_LOAD_ERROR) send({ id: m.id, error: JSON.parse(process.env.FAKE_LOAD_ERROR) })
    // Copilot 1.0.106 with a settings effortLevel and a model that takes none (#432 PR 5)
    else if (m.method === 'session/new' && process.env.FAKE_EFFORT_REFUSE && (process.env.FAKE_EFFORT_REFUSE === 'always' || !process.argv.slice(2).join(' ').includes('--reasoning-effort none'))) {
      send({ id: m.id, error: { code: -32603, message: "Model 'claude-haiku-4.5' does not support reasoning effort configuration" } })
      // slow to go: ignores its closed stdin and SIGTERM, so the driver's restart window stays open until SIGKILL
      if (process.env.FAKE_EFFORT_SLOW_EXIT) { slow = true; process.on('SIGTERM', () => {}); setInterval(() => {}, 1000) }
    }
    else if (m.method === 'session/new' || m.method === 'session/load') {
      send({ id: m.id, result: { ...(m.method === 'session/new' ? { sessionId: 's-1' } : {}), modes: { currentModeId: agent }, configOptions: config(agent) } })
      if (m.method === 'session/load') for (let i = 0; i < Number(process.env.FAKE_TOOLS_AFTER_LOAD || 0); i++) update({ sessionUpdate: 'tool_call', toolCallId: 'l-' + i, title: 'Read', kind: 'read', rawInput: {} })
    }
    else if (m.method === 'session/set_mode') {
      update({ sessionUpdate: 'current_mode_update', currentModeId: m.params.modeId })
      update({ sessionUpdate: 'config_option_update', configOptions: config(m.params.modeId) })
      send({ id: m.id, result: {} })
    } else if (m.method === 'session/prompt') {
      for (let i = 0; i < Number(process.env.FAKE_TOOLS || 0); i++) update({ sessionUpdate: 'tool_call', toolCallId: 'c-' + i, title: 'Read', kind: 'read', rawInput: {} })
      if (!process.env.FAKE_ASK) { send({ id: m.id, result: { stopReason: 'end_turn' } }); continue }
      prompt = m.id
      update({ sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'Run tests', kind: 'execute', rawInput: { command: 'npm test' } })
      send({ id: 900, method: 'session/request_permission', params: { sessionId: 's-1', toolCall: { toolCallId: 't-1', title: 'Run tests', kind: 'execute', rawInput: { command: 'npm test' } }, options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
      ] } })
    } else if (m.id === 900 && prompt !== null) {
      send({ id: prompt, result: { stopReason: 'end_turn' } })
      prompt = null
    } else if (m.method === 'session/cancel' && prompt !== null) {
      send({ id: prompt, result: { stopReason: 'cancelled' } })
      prompt = null
    }
  }
})
process.stdin.on('end', () => { if (!slow) process.exit(0) })
`

interface Rig {
  dir: string
  db: string
  fakeLog: string
  env: Record<string, string>
  hub: Database.Database
}

function rig(): Rig {
  const dir = scratchDir('driver-run-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'copilot'), FAKE_COPILOT)
  chmodSync(join(bin, 'copilot'), 0o755)
  writeFileSync(join(bin, 'fakenode'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", `'\\''`)}' "$@"\n`)
  chmodSync(join(bin, 'fakenode'), 0o755)
  const copilotHome = join(dir, 'copilot-home')
  mkdirSync(copilotHome)
  writeFileSync(join(copilotHome, 'mcp-config.json'), JSON.stringify({ mcpServers: { 'agent-inbox': { command: 'node', args: [] } } }))
  mkdirSync(join(dir, 'work'))
  const db = join(dir, 'hub', 'inbox.db')
  mkdirSync(dirname(db))
  const hub = openDb(db)
  open.push(hub)
  const fakeLog = join(dir, 'fake.ndjson')
  writeFileSync(fakeLog, '')
  return {
    dir, db, fakeLog, hub,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, COPILOT_HOME: copilotHome, FAKE_LOG: fakeLog },
  }
}

function newSpec(r: Rig, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, kind: 'new', launchId: LAUNCH, host: 'copilot', cwd: join(r.dir, 'work'), mode: 'ask',
    model: 'claude-haiku-4.5', reasoningEffort: 'none', budgets: { activeMs: 7_200_000, toolCalls: 500 },
    prompt: 'Fix the failing test.', env: r.env, launchKey: LAUNCH_KEY.toString('base64'), ...over,
  }
}

// `entry` runs a built driver-cli.js, as main does: no tsx, from '/'
function runDriver(r: Rig, spec: unknown, env: Record<string, string> = {}, entry?: string) {
  const argv = entry ? [entry] : ['--import', 'tsx', join(REPO, 'src', 'driver-cli.ts')]
  const child = spawn(process.execPath, [...argv, 'run', LAUNCH, r.db], {
    cwd: entry ? '/' : REPO,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_INBOX_DB: join(r.dir, 'elsewhere.db'), AGENT_INBOX_DRIVER_LINK_WAIT_MS: '0', ...env },
  })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (chunk) => { stdout += chunk })
  child.stderr!.on('data', (chunk) => { stderr += chunk })
  // fd 3 is a socket pair: once the driver closes its end, ours reads its end and closes
  const fd3 = child.stdio[3] as Duplex
  let fd3Closed = false
  fd3.once('close', () => { fd3Closed = true })
  fd3.resume()
  fd3.end(typeof spec === 'string' ? spec : JSON.stringify(spec))
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  return {
    child, exited,
    // the status line: the first that is not a phase line (#432 PR 5: main's dialog shows the phases)
    status: async () => {
      const line = () => stdout.split('\n').slice(0, -1).find((l) => !('phase' in JSON.parse(l)))
      await until(line, 'the status line', 20_000)
      return JSON.parse(line()!) as Record<string, unknown>
    },
    phases: () => stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => 'phase' in l).map((l) => l.phase),
    output: () => ({ stdout, stderr }),
    fd3Closed: () => fd3Closed,
  }
}

async function until<T>(read: () => T | undefined | false | null, label: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const received = (r: Rig) => readFileSync(r.fakeLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)

describe('agent-inbox-driver run (#412 step 3)', () => {
  it('reads its spec on fd 3, writes the launch row, reports one status line, and stops on the row’s Stop', async () => {
    const r = rig()
    const run = runDriver(r, newSpec(r))
    expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
    // the driver closed fd 3 (it carried the launch key) long before it exits
    await until(() => run.fd3Closed(), 'fd 3 closed by the driver', 5000)
    expect(run.child.exitCode).toBeNull()
    const row = await until(() => { const l = getLaunch(r.hub, LAUNCH); return l?.child_pgid ? l : null }, 'the child recorded')
    expect(row).toMatchObject({
      status: 'running', host: 'copilot', mode: 'ask', model: 'claude-haiku-4.5', reasoning_effort: 'none', prompt: 'Fix the failing test.',
      cwd: realpathSync(join(r.dir, 'work')), budget_active_ms: 7_200_000, budget_tool_calls: 500, spec_version: 1,
    })
    // the framed task reached copilot, started with the model and effort the spec named
    await until(() => received(r).find((m) => m.method === 'session/prompt'), 'the task')
    const prompt = received(r).find((m) => m.method === 'session/prompt')!
    expect(JSON.stringify(prompt)).toContain('The human started this session via Agent Inbox with this task:')
    expect(received(r)[0]).toEqual({
      argv: ['--acp', '--stdio', '--allow-tool', 'agent-inbox', '--model', 'claude-haiku-4.5', '--reasoning-effort', 'none'],
      env: { hooks: '0', db: r.db },
      // fd 3 carried the launch key: copilot and its shells never inherit it
      fd3: 'closed',
      cwd: realpathSync(join(r.dir, 'work')),
    })
    expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
    expect(await run.exited).toBe(0)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'stopped' })
    // #432 PR 5: one phase line for main's dialog, then exactly one status line, once the session was ready
    expect(run.output().stdout.trim().split('\n').map((l) => JSON.parse(l))).toEqual([{ phase: 'copilot' }, { ok: true, launch: LAUNCH }])
    expect(existsSync(join(r.dir, 'hub', 'launches', LAUNCH, 'events.ndjson'))).toBe(true)
  }, 40_000)

  it('parks when idle, keeping the prompted session, and a resume spec loads it without sending the task again', async () => {
    const r = rig()
    const first = runDriver(r, newSpec(r), { AGENT_INBOX_DRIVER_IDLE_MS: '400' })
    expect(await first.status()).toEqual({ ok: true, launch: LAUNCH })
    expect(await first.exited).toBe(0)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'parked', acp_session: 's-1', child_pgid: null, driver_pid: null })
    const before = received(r).filter((m) => m.method === 'session/prompt').length
    expect(before).toBe(1)

    // a Resume that cannot start parks the launch again as it was
    const broken = runDriver(r, { v: 1, kind: 'resume', launchId: LAUNCH, env: { ...r.env, PATH: '/usr/bin:/bin' }, launchKey: LAUNCH_KEY.toString('base64') })
    expect(await broken.status()).toEqual({ ok: false, error: 'no copilot executable on PATH (install GitHub Copilot CLI first)' })
    expect(await broken.exited).toBe(1)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'parked', acp_session: 's-1' })

    const resumed = runDriver(r, { v: 1, kind: 'resume', launchId: LAUNCH, env: r.env, launchKey: LAUNCH_KEY.toString('base64') })
    expect(await resumed.status()).toEqual({ ok: true, launch: LAUNCH })
    await until(() => received(r).find((m) => m.method === 'session/load'), 'the load')
    expect(received(r).find((m) => m.method === 'session/load')!.params).toMatchObject({ sessionId: 's-1', mcpServers: [] })
    await until(() => getLaunch(r.hub, LAUNCH)?.status === 'running', 'running again')
    expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
    expect(await resumed.exited).toBe(0)
    expect(received(r).filter((m) => m.method === 'session/prompt')).toHaveLength(before)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'stopped' })
  }, 40_000)

  it('Park now parks at its next idle point, exactly as the idle timeout parks, keeping the session to resume', async () => {
    const r = rig()
    const run = runDriver(r, newSpec(r))
    expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
    await until(() => received(r).find((m) => m.method === 'session/prompt'), 'the task')
    expect(requestLaunchPark(r.hub, LAUNCH)).toBe(true)
    expect(await run.exited).toBe(0)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'parked', acp_session: 's-1', end_reason: null, child_pgid: null, driver_pid: null })
    // the request went with the driver, and a parked launch takes no other
    expect(requestLaunchPark(r.hub, LAUNCH)).toBe(false)
    expect(readFileSync(join(r.dir, 'hub', 'launches', LAUNCH, 'events.ndjson'), 'utf8')).toContain('"event":"ended","reason":"park"')
  }, 40_000)

  it('full resume (step 5): a stopped launch keeps its session, resumes by loading it, and a refused resume leaves it stopped', async () => {
    const r = rig()
    const run = runDriver(r, newSpec(r))
    expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
    await until(() => received(r).find((m) => m.method === 'session/prompt'), 'the task')
    expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
    expect(await run.exited).toBe(0)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'stopped', acp_session: 's-1' })
    const broken = runDriver(r, { v: 1, kind: 'resume', launchId: LAUNCH, env: { ...r.env, PATH: '/usr/bin:/bin' }, launchKey: LAUNCH_KEY.toString('base64') })
    expect(await broken.status()).toMatchObject({ ok: false })
    expect(await broken.exited).toBe(1)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'stopped', acp_session: 's-1' })
    const resumed = runDriver(r, { v: 1, kind: 'resume', launchId: LAUNCH, env: r.env, launchKey: LAUNCH_KEY.toString('base64') })
    expect(await resumed.status()).toEqual({ ok: true, launch: LAUNCH })
    await until(() => received(r).find((m) => m.method === 'session/load'), 'the load')
    expect(received(r).find((m) => m.method === 'session/load')!.params).toMatchObject({ sessionId: 's-1' })
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'running', end_reason: null, ended_at: null, stop_requested_at: null })
    // the task is not sent again
    expect(received(r).filter((m) => m.method === 'session/prompt')).toHaveLength(1)
    expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
    expect(await resumed.exited).toBe(0)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'stopped', acp_session: 's-1' })
  }, 40_000)

  it('Take over (step 5): mid-approval, the driver cancels the turn, settles the ask, ends Copilot’s whole group and hands the session off', async () => {
    const r = rig()
    const run = runDriver(r, newSpec(r, { env: { ...r.env, FAKE_ASK: '1', FAKE_GROUP_SLEEPER: '1' } }))
    expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
    const ask = await until(() => listItems(r.hub).find((i) => i.project === '@sessions' && i.status === 'open'), 'the ask')
    const pgid = (await until(() => getLaunch(r.hub, LAUNCH)?.child_pgid, 'the child recorded'))!
    expect(handOffForTerminal(r.hub, LAUNCH)).toEqual({ ok: true, state: 'requested' })
    expect(await run.exited).toBe(0)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'handed_off', acp_session: 's-1', child_pgid: null })
    expect(listItems(r.hub).find((i) => i.id === ask.id)).toMatchObject({ status: 'resolved', outcome: 'Handed off to a terminal.' })
    // the open request was answered cancelled, then the turn cancelled
    const sent = received(r)
    expect(sent.find((m) => m.id === 900)).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    expect(sent.some((m) => m.method === 'session/cancel')).toBe(true)
    // nothing of that Copilot is left to write to the session the terminal resumes
    expect(() => process.kill(-pgid, 0)).toThrow()
    expect(handOffForTerminal(r.hub, LAUNCH)).toMatchObject({ ok: true, state: 'handed_off', session: 's-1', cwd: realpathSync(join(r.dir, 'work')) })
    const events = readFileSync(join(r.dir, 'hub', 'launches', LAUNCH, 'events.ndjson'), 'utf8')
    expect(events).toContain('"event":"handoff_requested"')
    expect(events).toContain('"event":"ended","reason":"handed_off"')
  }, 40_000)

  it('Edits in the worktree pre-allows writes under the folder it resolved and denies its .git, and refuses the home folder', async () => {
    const r = rig()
    const run = runDriver(r, newSpec(r, { mode: 'edits' }))
    expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
    await until(() => received(r).find((m) => m.method === 'session/prompt'), 'the task')
    const work = realpathSync(join(r.dir, 'work'))
    expect(received(r)[0]!.argv).toEqual([
      '--acp', '--stdio', '--allow-tool', 'agent-inbox', '--allow-tool', `write(${work}/**)`,
      '--deny-tool', `write(${work}/.git)`, '--deny-tool', `write(${work}/.git/**)`,
      '--deny-tool', `write(${work}/**/.git)`, '--deny-tool', `write(${work}/**/.git/**)`,
      '--model', 'claude-haiku-4.5', '--reasoning-effort', 'none',
    ])
    expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
    expect(await run.exited).toBe(0)

    const home = rig()
    const refused = runDriver(home, newSpec(home, { mode: 'edits', cwd: home.dir }))
    expect(await refused.status()).toMatchObject({ ok: false, error: expect.stringMatching(/^Edits in the worktree cannot use .*not your home folder/) })
    expect(await refused.exited).toBe(1)
    expect(getLaunch(home.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'error:start' })
    expect(readFileSync(home.fakeLog, 'utf8')).toBe('')
  }, 40_000)

  // #432: a launch in its own worktree, made by the driver from the checkout's HEAD before its status line
  describe('in its own worktree (#432)', () => {
    const SHORT = LAUNCH.slice(0, 8)
    // the scratch folder's work/ as a repository with one commit; git's config is the scratch HOME's
    function checkout(r: Rig): { git: (cwd: string, ...args: string[]) => string; work: string; plan: { path: string; branch: string } } {
      const env = { ...r.env, GIT_CONFIG_NOSYSTEM: '1' }
      const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim()
      const work = realpathSync(join(r.dir, 'work'))
      git(work, '-c', 'init.defaultBranch=main', 'init', '-q')
      writeFileSync(join(work, 'README.md'), 'hello\n')
      git(work, 'add', 'README.md')
      git(work, '-c', 'user.name=shariqh', '-c', 'user.email=shariqh@users.noreply.github.com', 'commit', '-q', '-m', 'first')
      const leaf = `fix-the-failing-test-${SHORT}`
      return { git, work, plan: { path: join(realpathSync(r.dir), 'worktrees', 'work', leaf), branch: `agent-inbox/${leaf}` } }
    }
    const locked = (list: string, path: string) => list.split('\n\n').find((entry) => entry.startsWith(`worktree ${path}\n`))?.includes('\nlocked')

    it('runs copilot in a new locked worktree it records, allows a dirty checkout, and unlocks it at the end, keeping it and its branch', async () => {
      const r = rig()
      const { git, work, plan } = checkout(r)
      writeFileSync(join(work, 'README.md'), 'uncommitted\n')
      const run = runDriver(r, newSpec(r, { worktree: plan }))
      expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
      await until(() => received(r).find((m) => m.method === 'session/prompt'), 'the task')
      expect(received(r)[0]!.cwd).toBe(plan.path)
      expect(getLaunch(r.hub, LAUNCH)).toMatchObject({
        status: 'running', cwd: plan.path, worktree_path: plan.path, checkout_root: work, branch: plan.branch, stream: plan.branch,
        project: 'work', base_sha: git(work, 'rev-parse', 'HEAD'), base_ref: 'refs/heads/main', worktree_removed_at: null,
      })
      expect(locked(git(work, 'worktree', 'list', '--porcelain'), plan.path)).toBe(true)
      expect(readFileSync(join(plan.path, 'README.md'), 'utf8')).toBe('hello\n')
      const events = readFileSync(join(r.dir, 'hub', 'launches', LAUNCH, 'events.ndjson'), 'utf8')
      expect(events).toContain('"event":"checkout_dirty","count":1')
      expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
      expect(await run.exited).toBe(0)
      expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', worktree_removed_at: null })
      expect(locked(git(work, 'worktree', 'list', '--porcelain'), plan.path)).toBe(false)
      expect(existsSync(plan.path)).toBe(true)
      expect(git(work, 'branch', '--list', plan.branch)).toContain(plan.branch)
    }, 40_000)

    it('writes the worktree’s summary at the turn end and at the end (§6)', async () => {
      const r = rig()
      const { git, plan } = checkout(r)
      const run = runDriver(r, newSpec(r, { worktree: plan }))
      expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
      // the task's turn ends at once: its summary arrives off the event queue
      const first = await until(() => getLaunch(r.hub, LAUNCH)?.worktree_summary, 'the turn-end summary')
      expect(JSON.parse(first)).toEqual({ v: 1, at: expect.any(String), head: git(plan.path, 'rev-parse', 'HEAD'), branch: plan.branch, ahead: 0, behind: 0, files: 0, dirty: 0 })
      writeFileSync(join(plan.path, 'notes.txt'), 'notes\n')
      expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
      expect(await run.exited).toBe(0)
      expect(JSON.parse(getLaunch(r.hub, LAUNCH)!.worktree_summary!)).toMatchObject({ dirty: 1 })
    }, 40_000)

    // review of #448: the git the driver finds first on the spec's PATH, recording each call and, while
    // HANG exists, hanging on `branch --show-current` (only the summary runs it)
    function hangingGit(r: Rig) {
      const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim()
      const calls = join(r.dir, 'git-calls.log')
      writeFileSync(join(r.dir, 'bin', 'git'), `#!/bin/sh\necho "$$ $*" >> '${calls}'\nif [ "$3" = branch ] && [ -e '${join(r.dir, 'HANG')}' ]; then exec sleep 600; fi\nexec '${real}' "$@"\n`)
      chmodSync(join(r.dir, 'bin', 'git'), 0o755)
      writeFileSync(join(r.dir, 'HANG'), '')
      return () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '').split('\n').filter((l) => l.includes(' branch --show-current')).map((l) => Number(l.split(' ')[0]))
    }

    it.each([
      ['a Stop', 'stopped', {}],
      ['a park', 'parked', { AGENT_INBOX_DRIVER_IDLE_MS: '1500' }],
    ] as Array<[string, string, Record<string, string>]>)('%s with a summary git that hangs ends within the final budget, holding its lease until then, never lost', async (_, status, env) => {
      const r = rig()
      const { plan } = checkout(r)
      const hung = hangingGit(r)
      const run = runDriver(r, newSpec(r, { worktree: plan }), { AGENT_INBOX_DRIVER_SUMMARY_FINAL_MS: '1500', ...env })
      expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
      await until(() => hung().length > 0, 'the turn-end summary hanging')
      if (status === 'stopped') expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
      const seen: string[] = []
      const started = Date.now()
      while (run.child.exitCode === null) {
        const row = getLaunch(r.hub, LAUNCH)!
        seen.push(row.status)
        // while the row is not closed, its driver's lease stands, so nobody can Close it as lost
        if (row.status === 'running') {
          const alive = launchDriverAlive(r.hub, LAUNCH)
          const close = closeLostLaunch(r.hub, LAUNCH)
          // the row may close between the reads; either way, a lease stands until it does
          if (getLaunch(r.hub, LAUNCH)!.status === 'running') expect(alive).toBe(true)
          expect(close).toMatchObject({ ok: false, reason: expect.stringMatching(/^(driver_alive|not_running)$/) })
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(await run.exited).toBe(0)
      // the child's 10 s grace is not spent: it exits about 1 s after its stdin closes
      expect(Date.now() - started).toBeLessThan(8000)
      expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: status === 'stopped' ? 'ended' : 'parked' })
      expect(seen).not.toContain('lost')
      expect(getLaunch(r.hub, LAUNCH)!.end_reason).not.toBe('lost')
      expect(launchDriverAlive(r.hub, LAUNCH)).toBe(false)
      for (const pid of hung()) expect(() => process.kill(pid, 0)).toThrow()
    }, 40_000)

    it('a summary git that hangs does not hold up the event queue: a plan approval is acted on at once', async () => {
      const r = rig()
      const { plan } = checkout(r)
      const hung = hangingGit(r)
      const run = runDriver(r, newSpec(r, { worktree: plan, mode: 'plan' }), { AGENT_INBOX_DRIVER_SUMMARY_FINAL_MS: '1500' })
      expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
      const ask = await until(() => listItems(r.hub).find((i) => i.project === '@sessions' && i.status === 'open'), 'the plan approval')
      expect(ask.title).toBe('Approve the plan and continue?')
      await until(() => hung().length > 0, 'the turn-end summary hanging')
      const pids = hung()
      const before = received(r).filter((m) => m.method === 'session/set_mode').length
      const answered = Date.now()
      replyItem(r.hub, ask.id, 'approve', sign(LAUNCH_KEY, ask.id, 0, 'approve'))
      await until(() => received(r).filter((m) => m.method === 'session/set_mode').length > before, 'the switch to agent mode', 5000)
      expect(Date.now() - answered).toBeLessThan(2500)
      // the summary's git was still hanging all along
      for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow()
      expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
      expect(await run.exited).toBe(0)
    }, 40_000)

    it('keeps the lock while parked, and a resumed driver runs there and unlocks it when the launch ends', async () => {
      const r = rig()
      const { git, work, plan } = checkout(r)
      const run = runDriver(r, newSpec(r, { worktree: plan }), { AGENT_INBOX_DRIVER_IDLE_MS: '400' })
      expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
      expect(await run.exited).toBe(0)
      expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'parked', worktree_path: plan.path })
      expect(locked(git(work, 'worktree', 'list', '--porcelain'), plan.path)).toBe(true)
      const resumed = runDriver(r, { v: 1, kind: 'resume', launchId: LAUNCH, env: r.env, launchKey: LAUNCH_KEY.toString('base64') })
      expect(await resumed.status()).toEqual({ ok: true, launch: LAUNCH })
      await until(() => received(r).find((m) => m.method === 'session/load'), 'the load')
      expect(received(r).filter((m) => 'argv' in m).map((m) => m.cwd)).toEqual([plan.path, plan.path])
      expect(locked(git(work, 'worktree', 'list', '--porcelain'), plan.path)).toBe(true)
      expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
      expect(await resumed.exited).toBe(0)
      expect(locked(git(work, 'worktree', 'list', '--porcelain'), plan.path)).toBe(false)
    }, 40_000)

    it('a stopped launch resumed runs in its worktree locked again, and unlocks it when it ends again (step 5)', async () => {
      const r = rig()
      const { git, work, plan } = checkout(r)
      const run = runDriver(r, newSpec(r, { worktree: plan }))
      expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
      await until(() => received(r).find((m) => m.method === 'session/prompt'), 'the task')
      expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
      expect(await run.exited).toBe(0)
      expect(locked(git(work, 'worktree', 'list', '--porcelain'), plan.path)).toBe(false)
      const resumed = runDriver(r, { v: 1, kind: 'resume', launchId: LAUNCH, env: r.env, launchKey: LAUNCH_KEY.toString('base64') })
      expect(await resumed.status()).toEqual({ ok: true, launch: LAUNCH })
      expect(locked(git(work, 'worktree', 'list', '--porcelain'), plan.path)).toBe(true)
      expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
      expect(await resumed.exited).toBe(0)
      expect(locked(git(work, 'worktree', 'list', '--porcelain'), plan.path)).toBe(false)
    }, 40_000)

    it('a refusal after it made the worktree leaves no worktree, branch or lock, and the row says it is gone', async () => {
      const r = rig()
      const { git, work, plan } = checkout(r)
      rmSync(join(r.dir, 'bin', 'copilot'))
      const run = runDriver(r, newSpec(r, { worktree: plan }))
      expect(await run.status()).toEqual({ ok: false, error: 'no copilot executable on PATH (install GitHub Copilot CLI first)' })
      expect(await run.exited).toBe(1)
      expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'error:start', worktree_path: plan.path })
      expect(getLaunch(r.hub, LAUNCH)!.worktree_removed_at).not.toBeNull()
      expect(existsSync(plan.path)).toBe(false)
      expect(git(work, 'branch', '--format=%(refname:short)')).toBe('main')
      expect(git(work, 'worktree', 'list', '--porcelain')).not.toContain(plan.path)
    }, 40_000)

    // `driver-cli.js worktree inspect|remove <id> <hub>`, as main runs it with the env it captured in the checkout
    const worktreeCli = (r: Rig, args: string[]) => {
      const out = execFileSync(process.execPath, ['--import', 'tsx', join(REPO, 'src', 'driver-cli.ts'), 'worktree', ...args], {
        cwd: REPO, env: { ...r.env, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }) as string
      return JSON.parse(out.trim().split('\n')[0]!) as Record<string, unknown>
    }
    const worktreeCliFails = (r: Rig, args: string[]) => {
      try {
        worktreeCli(r, args)
      } catch (error) {
        const failed = error as { status: number; stdout: string }
        return { code: failed.status, ...(failed.stdout ? JSON.parse(failed.stdout.trim()) as Record<string, unknown> : {}) }
      }
      throw new Error('the command succeeded')
    }

    it('worktree inspect and remove act only on an ended launch’s kept worktree, never its branch', async () => {
      const r = rig()
      const { git, work, plan } = checkout(r)
      const run = runDriver(r, newSpec(r, { worktree: plan }), { AGENT_INBOX_DRIVER_IDLE_MS: '400' })
      expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
      expect(await run.exited).toBe(0)
      // parked: refused, and so is a running one
      expect(worktreeCliFails(r, ['inspect', LAUNCH, r.db])).toEqual({ code: 1, ok: false, error: 'End the session before removing its worktree.' })
      expect(requestLaunchStop(r.hub, LAUNCH)).toBe('ended')
      writeFileSync(join(plan.path, 'notes.txt'), 'notes\n')
      const seen = worktreeCli(r, ['inspect', LAUNCH, r.db])
      expect(seen).toEqual({
        ok: true, path: plan.path, branch: plan.branch, missing: false, dirty: 1, examples: ['notes.txt'], noDiscard: null, ahead: 0, upstream: false,
        status: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
      expect(worktreeCliFails(r, ['remove', LAUNCH, r.db])).toMatchObject({ code: 1, ok: false })
      expect(worktreeCliFails(r, ['remove', LAUNCH, r.db, '--discard', 'f'.repeat(64)])).toMatchObject({ code: 1, error: expect.stringMatching(/changed since you looked/) })
      expect(getLaunch(r.hub, LAUNCH)!.worktree_removed_at).toBeNull()
      expect(worktreeCli(r, ['remove', LAUNCH, r.db, '--discard', String(seen.status)])).toEqual({ ok: true })
      expect(existsSync(plan.path)).toBe(false)
      expect(getLaunch(r.hub, LAUNCH)!.worktree_removed_at).not.toBeNull()
      expect(git(work, 'branch', '--list', plan.branch)).toContain(plan.branch)
      expect(worktreeCliFails(r, ['inspect', LAUNCH, r.db])).toMatchObject({ code: 1, error: 'This session’s worktree was already removed.' })
      expect(worktreeCliFails(r, ['remove', LAUNCH, r.db, '--discard', 'nothex'])).toEqual({ code: 64 })
    }, 40_000)

    it('refuses a folder that is not a repository’s top before writing any row', async () => {
      const r = rig()
      const { plan } = checkout(r)
      mkdirSync(join(r.dir, 'work', 'sub'))
      const run = runDriver(r, newSpec(r, { cwd: join(r.dir, 'work', 'sub'), worktree: plan }))
      expect(String((await run.status()).error)).toMatch(/is not the top folder of a git repository/)
      expect(await run.exited).toBe(1)
      expect(getLaunch(r.hub, LAUNCH)).toBeNull()
      expect(existsSync(plan.path)).toBe(false)
      expect(readFileSync(r.fakeLog, 'utf8')).toBe('')
    }, 40_000)
  })

  // #432 PR 5: Copilot's settings set an effort the model does not take, and the human left it to Copilot
  describe('the reasoning-effort fallback', () => {
    const REFUSED = "Model 'claude-haiku-4.5' does not support reasoning effort configuration"
    const APP_HINT = 'This model takes no reasoning effort: choose Reasoning effort: none in New session, or another model.'
    const starts = (r: Rig) => received(r).filter((m) => 'argv' in m).map((m) => m.argv as string[])
    const events = (r: Rig) => readFileSync(join(r.dir, 'hub', 'launches', LAUNCH, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)

    it('starts Copilot once more with none, on the same launch, slot and logs, and records the effort it runs with', async () => {
      const r = rig()
      const run = runDriver(r, newSpec(r, { reasoningEffort: undefined, env: { ...r.env, FAKE_EFFORT_REFUSE: '1' } }))
      expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
      expect(starts(r)).toEqual([
        ['--acp', '--stdio', '--allow-tool', 'agent-inbox', '--model', 'claude-haiku-4.5'],
        ['--acp', '--stdio', '--allow-tool', 'agent-inbox', '--model', 'claude-haiku-4.5', '--reasoning-effort', 'none'],
      ])
      await until(() => received(r).find((m) => m.method === 'session/prompt'), 'the task')
      expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'running', reasoning_effort: 'none', end_detail: null })
      // the driver kept its slot across the restart: its lease never left
      expect(claimDriverSlot(r.hub, { launchId: '44444444-4444-4444-8444-000000000001', pid: 1, nonce: 'x' }, 1)).toMatchObject({ ok: false })
      const log = events(r)
      expect(log.filter((e) => e.event === 'effort_fallback')).toHaveLength(1)
      expect(log).toContainEqual(expect.objectContaining({ event: 'notice', text: 'This model takes no reasoning effort, so Agent Inbox started it with none.' }))
      expect(log).toContainEqual(expect.objectContaining({ event: 'ended', reason: 'error:setup', retry: 'effort' }))
      expect(log).toContainEqual(expect.objectContaining({ event: 'startup' }))
      expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
      expect(await run.exited).toBe(0)
      expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'stopped' })
    }, 40_000)

    it('falls back only once: a second refusal ends it as not started, in the app’s words', async () => {
      const r = rig()
      const run = runDriver(r, newSpec(r, { reasoningEffort: undefined, env: { ...r.env, FAKE_EFFORT_REFUSE: 'always' } }))
      expect(await run.status()).toEqual({ ok: false, error: `Copilot refused to start the session: ${REFUSED} ${APP_HINT}` })
      expect(await run.exited).toBe(1)
      expect(starts(r)).toHaveLength(2)
      expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'error:setup', end_detail: `Copilot refused to start the session: ${REFUSED} ${APP_HINT}` })
    }, 40_000)

    it('never falls back from an effort the human chose', async () => {
      const r = rig()
      const run = runDriver(r, newSpec(r, { reasoningEffort: 'high', env: { ...r.env, FAKE_EFFORT_REFUSE: '1' } }))
      expect(await run.status()).toEqual({ ok: false, error: `Copilot refused to start the session: ${REFUSED} ${APP_HINT}` })
      expect(await run.exited).toBe(1)
      expect(starts(r)).toHaveLength(1)
      expect(events(r).some((e) => e.event === 'effort_fallback')).toBe(false)
      expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ reasoning_effort: 'high', end_reason: 'error:setup' })
    }, 40_000)

    // session/new is sent only before any prompt, so the effort match on it is the whole guard: a resumed
    // (prompted) session's load is never retried without an effort, however Copilot refuses it
    it('never retries a refused session/load: a resumed session parks again', async () => {
      const r = rig()
      const first = runDriver(r, newSpec(r, { reasoningEffort: undefined }), { AGENT_INBOX_DRIVER_IDLE_MS: '400' })
      expect(await first.status()).toEqual({ ok: true, launch: LAUNCH })
      expect(await first.exited).toBe(0)
      const resumed = runDriver(r, {
        v: 1, kind: 'resume', launchId: LAUNCH, launchKey: LAUNCH_KEY.toString('base64'),
        env: { ...r.env, FAKE_EFFORT_REFUSE: 'always', FAKE_LOAD_ERROR: JSON.stringify({ code: -32603, message: REFUSED }) },
      })
      expect(await resumed.status()).toEqual({ ok: false, error: `Copilot could not load the session: ${REFUSED}` })
      expect(await resumed.exited).toBe(1)
      expect(starts(r)).toHaveLength(2)
      expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'parked', reasoning_effort: null })
    }, 40_000)

    it.each([
      ['a SIGTERM', (run: ReturnType<typeof runDriver>) => { run.child.kill('SIGTERM') }],
      ['the row’s Stop', (_run: ReturnType<typeof runDriver>, r: Rig) => { expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping') }],
    ] as Array<[string, (run: ReturnType<typeof runDriver>, r: Rig) => void]>)('%s while it restarts Copilot starts no second one, and ends the launch as stopped', async (_, stop) => {
      const r = rig()
      const run = runDriver(r, newSpec(r, { reasoningEffort: undefined, env: { ...r.env, FAKE_EFFORT_REFUSE: '1', FAKE_EFFORT_SLOW_EXIT: '1' } }))
      // the first Copilot refused and the driver ended for the retry; that Copilot is still going (SIGKILL in about 2 s)
      await until(() => existsSync(join(r.dir, 'hub', 'launches', LAUNCH, 'events.ndjson')) && events(r).some((e) => e.event === 'ended' && e.retry === 'effort'), 'the retry')
      stop(run, r)
      expect(await run.status()).toEqual({ ok: false, error: 'It was stopped before the session started.' })
      expect(await run.exited).toBe(0)
      expect(starts(r)).toHaveLength(1)
      expect(events(r).some((e) => e.event === 'effort_fallback')).toBe(false)
      expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'stopped', end_detail: 'It was stopped before the session started.', reasoning_effort: null })
      expect(launchDriverAlive(r.hub, LAUNCH)).toBe(false)
    }, 40_000)

    it('a launch that never got ready says why on its row, and the status line says it to main', async () => {
      const r = rig()
      rmSync(join(r.dir, 'bin', 'copilot'))
      const refused = runDriver(r, newSpec(r))
      expect(await refused.status()).toEqual({ ok: false, error: 'no copilot executable on PATH (install GitHub Copilot CLI first)' })
      expect(await refused.exited).toBe(1)
      expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ end_reason: 'error:start', end_detail: 'no copilot executable on PATH (install GitHub Copilot CLI first)' })
    }, 40_000)
  })

  it('allows a tool call only on a reply signed under the launch key from its spec', async () => {
    const r = rig()
    const run = runDriver(r, newSpec(r, { env: { ...r.env, FAKE_ASK: '1' } }))
    expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
    const ask = await until(() => listItems(r.hub).find((i) => i.project === '@sessions' && i.status === 'open'), 'the ask')
    expect(ask).toMatchObject({ action_owner: 'approval', title: 'Allow copilot to run `npm test`?' })
    replyItem(r.hub, ask.id, 'allow_once', sign(Buffer.alloc(32, 1), ask.id, 0, 'allow_once'))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(received(r).some((m) => m.id === 900)).toBe(false)
    replyItem(r.hub, ask.id, 'allow_once', sign(LAUNCH_KEY, ask.id, 0, 'allow_once'))
    await until(() => received(r).find((m) => m.id === 900), 'the answer')
    expect(received(r).find((m) => m.id === 900)!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    requestLaunchStop(r.hub, LAUNCH)
    expect(await run.exited).toBe(0)
  }, 40_000)

  it.each([
    ['not JSON', () => 'not json', /launch spec: not JSON/],
    ['a spec for another launch', (r: Rig) => newSpec(r, { launchId: '33333333-3333-4333-8333-333333333333' }), /launchId must be/],
    ['an unknown field', (r: Rig) => newSpec(r, { argv: ['--yolo'] }), /unknown field argv/],
    ['a newer spec version', (r: Rig) => newSpec(r, { v: 2 }), /version 2 is not 1/],
  ] as Array<[string, (r: Rig) => unknown, RegExp]>)('refuses %s before touching the hub', async (_, spec, error) => {
    const r = rig()
    const run = runDriver(r, spec(r))
    const status = await run.status()
    expect(status.ok).toBe(false)
    expect(String(status.error)).toMatch(error)
    expect(await run.exited).toBe(65)
    expect(getLaunch(r.hub, LAUNCH)).toBeNull()
    expect(existsSync(r.fakeLog) && readFileSync(r.fakeLog, 'utf8')).toBe('')
  })

  it('refuses to resume a launch that is not parked, and to start past the driver cap, naming what runs', async () => {
    const r = rig()
    const resume = runDriver(r, { v: 1, kind: 'resume', launchId: LAUNCH, env: r.env, launchKey: LAUNCH_KEY.toString('base64') })
    expect(await resume.status()).toEqual({ ok: false, error: `launch ${LAUNCH} is not parked or stopped with its session` })
    expect(await resume.exited).toBe(1)
    for (const [n, pid] of [[1, 101], [2, 102]] as const) {
      expect(claimDriverSlot(r.hub, { launchId: `44444444-4444-4444-8444-00000000000${n}`, pid, nonce: 'other' }, 2)).toEqual({ ok: true })
    }
    const capped = runDriver(r, newSpec(r))
    const status = await capped.status()
    expect(status).toMatchObject({ ok: false })
    expect(String(status.error)).toMatch(/2 driven sessions are already running/)
    expect(await capped.exited).toBe(75)
    expect(getLaunch(r.hub, LAUNCH)).toBeNull()
    // #432 §5: the spec's own cap, counting every driver: 3 starts beside the 2 running
    const higher = runDriver(r, newSpec(r, { maxDrivers: 3 }))
    expect(await higher.status()).toEqual({ ok: true, launch: LAUNCH })
    expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
    expect(await higher.exited).toBe(0)
  }, 40_000)

  it('a spec cap of 1 refuses beside 1 running driver, where the default 2 starts (#432 §5)', async () => {
    const r = rig()
    expect(claimDriverSlot(r.hub, { launchId: '44444444-4444-4444-8444-000000000001', pid: 101, nonce: 'other' }, 2)).toEqual({ ok: true })
    const lower = runDriver(r, newSpec(r, { maxDrivers: 1 }))
    expect(String((await lower.status()).error)).toMatch(/1 driven sessions are already running/)
    expect(await lower.exited).toBe(75)
    expect(getLaunch(r.hub, LAUNCH)).toBeNull()
    const byDefault = runDriver(r, newSpec(r))
    expect(await byDefault.status()).toEqual({ ok: true, launch: LAUNCH })
    expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
    expect(await byDefault.exited).toBe(0)
  }, 40_000)

  it.each([
    ['a shebang that passes the interpreter flags', (bin: string) => {
      writeFileSync(join(bin, 'copilot'), FAKE_COPILOT.replace('#!/usr/bin/env fakenode', '#!/usr/bin/env fakenode --require=/elsewhere/hook.js'))
    }, /names an interpreter this driver does not resolve/],
    ['a host others can write', (bin: string) => chmodSync(join(bin, 'copilot'), 0o775), /copilot is not owned by you or root, or is writable by others; refusing to run it/],
    // the interpreter is checked like the host (§8), on every OS
    ['an interpreter others can write', (bin: string) => chmodSync(join(bin, 'fakenode'), 0o775), /fakenode is not owned by you or root, or is writable by others; refusing to run it/],
  ] as Array<[string, (bin: string) => void, RegExp]>)('refuses %s, ending the launch it wrote without starting anything', async (_, spoil, error) => {
    const r = rig()
    spoil(join(r.dir, 'bin'))
    const run = runDriver(r, newSpec(r))
    const status = await run.status()
    expect(status.ok).toBe(false)
    expect(String(status.error)).toMatch(error)
    expect(await run.exited).toBe(1)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'error:start' })
    expect(readFileSync(r.fakeLog, 'utf8')).toBe('')
  })

  it('a resume whose load fails parks the launch again with the reason; one never prompted starts fresh and sends the task', async () => {
    const r = rig()
    const first = runDriver(r, newSpec(r), { AGENT_INBOX_DRIVER_IDLE_MS: '400' })
    expect(await first.status()).toEqual({ ok: true, launch: LAUNCH })
    expect(await first.exited).toBe(0)
    const resumeSpec = (env: Record<string, string>) => ({ v: 1, kind: 'resume', launchId: LAUNCH, env: { ...r.env, ...env }, launchKey: LAUNCH_KEY.toString('base64') })

    const failed = runDriver(r, resumeSpec({ FAKE_LOAD_ERROR: JSON.stringify({ code: -32603, message: 'Internal error' }) }))
    // the status line tells main why, so Resume shows it (#432 PR 5)
    expect(await failed.status()).toEqual({ ok: false, error: 'Copilot could not load the session: Internal error' })
    expect(await failed.exited).toBe(1)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({
      status: 'parked', acp_session: 's-1', park_reason: 'Copilot could not load the session: Internal error', end_reason: null,
    })

    const fresh = runDriver(r, resumeSpec({ FAKE_LOAD_ERROR: JSON.stringify({ code: -32002, message: 'Resource not found' }) }))
    expect(await fresh.status()).toEqual({ ok: true, launch: LAUNCH })
    await until(() => received(r).filter((m) => m.method === 'session/prompt').length === 2, 'the task again')
    expect(received(r).filter((m) => m.method === 'session/new')).toHaveLength(2)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'running', park_reason: null })
    requestLaunchStop(r.hub, LAUNCH)
    expect(await fresh.exited).toBe(0)
  }, 40_000)

  it('keeps its budgets per launch across park and resume: a resumed launch ends at the original total, and usage never goes back', async () => {
    const r = rig()
    const first = runDriver(r, newSpec(r, { budgets: { activeMs: 7_200_000, toolCalls: 3 }, env: { ...r.env, FAKE_TOOLS: '2' } }), { AGENT_INBOX_DRIVER_IDLE_MS: '400' })
    expect(await first.status()).toEqual({ ok: true, launch: LAUNCH })
    expect(await first.exited).toBe(0)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'parked', tool_calls: 2 })
    // the loaded session makes one more tool call: 3 of 3 for the launch, not 1 of 3
    const resumed = runDriver(r, { v: 1, kind: 'resume', launchId: LAUNCH, env: { ...r.env, FAKE_TOOLS_AFTER_LOAD: '1' }, launchKey: LAUNCH_KEY.toString('base64') })
    expect(await resumed.status()).toEqual({ ok: false, error: 'It has used its tool-call budget.' })
    expect(await resumed.exited).toBe(1)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'budget:tool_calls', tool_calls: 3 })
  }, 40_000)

  it('a resume of a launch that already used its tool-call budget ends it at once without starting copilot', async () => {
    const r = rig()
    const first = runDriver(r, newSpec(r, { budgets: { activeMs: 7_200_000, toolCalls: 3 }, env: { ...r.env, FAKE_TOOLS: '2' } }), { AGENT_INBOX_DRIVER_IDLE_MS: '400' })
    expect(await first.status()).toEqual({ ok: true, launch: LAUNCH })
    expect(await first.exited).toBe(0)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'parked', tool_calls: 2 })
    // the row says 3 of 3 were used (a later turn's report), as a park can record
    recordLaunchProgress(r.hub, LAUNCH, { toolCalls: 1 })
    expect(getLaunch(r.hub, LAUNCH)!.tool_calls).toBe(2)
    r.hub.prepare(`UPDATE launches SET tool_calls = 3 WHERE id = ?`).run(LAUNCH)
    const starts = readFileSync(r.fakeLog, 'utf8').split('\n').filter((line) => line.includes('"argv"')).length
    const resumed = runDriver(r, { v: 1, kind: 'resume', launchId: LAUNCH, env: r.env, launchKey: LAUNCH_KEY.toString('base64') })
    expect(await resumed.status()).toEqual({ ok: false, error: `launch ${LAUNCH} has used its tool-call budget` })
    expect(await resumed.exited).toBe(1)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'budget:tool_calls', tool_calls: 3 })
    expect(readFileSync(r.fakeLog, 'utf8').split('\n').filter((line) => line.includes('"argv"'))).toHaveLength(starts)
  }, 40_000)

  // #435 (design §5): on macOS a release app with no installed runtime starts the driver from the
  // payload inside its own bundle. An update renames that bundle aside and deletes it later; the
  // driver has loaded its whole graph and its SQLite addon by then, so it runs on to a clean end.
  it('a driver started from a payload copy finishes cleanly after the copy is renamed aside and deleted, and pins nothing', async () => {
    const r = rig()
    const payload = join(scratchDir('driver-payload-'), 'runtime', 'darwin-arm64')
    execFileSync(process.execPath, [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json', '--outDir', join(payload, 'dist')], { cwd: REPO })
    cpSync(join(REPO, 'scripts'), join(payload, 'scripts'), { recursive: true })
    cpSync(join(REPO, 'public'), join(payload, 'public'), { recursive: true })
    cpSync(join(REPO, 'package.json'), join(payload, 'package.json'))
    // the driver's only packages: better-sqlite3 and what loads its addon
    for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
      cpSync(join(REPO, 'node_modules', name), join(payload, 'node_modules', name), { recursive: true })
    }
    const runtimeRoot = join(r.dir, 'runtime')
    mkdirSync(runtimeRoot)
    const run = runDriver(r, newSpec(r, { env: { ...r.env, FAKE_ASK: '1' } }), { AGENT_INBOX_RUNTIME_ROOT: runtimeRoot }, join(payload, 'dist', 'driver-cli.js'))
    expect(await run.status()).toEqual({ ok: true, launch: LAUNCH })
    // what the macOS update does: rename the old app aside, and delete it later
    const aside = `${dirname(dirname(payload))}.aside`
    renameSync(dirname(dirname(payload)), aside)
    rmSync(aside, { recursive: true, force: true })
    expect(existsSync(aside) || existsSync(payload)).toBe(false)
    // one turn and one signed approval, filed and settled through the hub after the swap
    const ask = await until(() => listItems(r.hub).find((i) => i.project === '@sessions' && i.status === 'open'), 'the ask')
    replyItem(r.hub, ask.id, 'allow_once', sign(LAUNCH_KEY, ask.id, 0, 'allow_once'))
    await until(() => received(r).find((m) => m.id === 900), 'the answer')
    expect(received(r).find((m) => m.id === 900)!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    await until(() => listItems(r.hub).find((i) => i.id === ask.id && i.status !== 'open'), 'the ask settled')
    expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
    expect(await run.exited).toBe(0)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'stopped' })
    expect(run.output().stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module|ENOENT/)
    // a bundle's payload is no installed runtime: nothing was pinned
    expect(readdirSync(runtimeRoot)).toEqual([])
  }, 60_000)

  it('refuses without touching fd 3 when main passed no spec pipe there: exit 65 and the status line, never an abort', async () => {
    const r = rig()
    const child = spawn(process.execPath, ['--import', 'tsx', join(REPO, 'src', 'driver-cli.ts'), 'run', LAUNCH, r.db], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AGENT_INBOX_DB: join(r.dir, 'elsewhere.db') },
    })
    let stdout = ''
    child.stdout!.on('data', (chunk) => { stdout += chunk })
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
    expect({ code, signal }).toEqual({ code: 65, signal: null })
    expect(JSON.parse(stdout.trim())).toEqual({ ok: false, error: 'no launch spec on fd 3 (Electron main passes it on a pipe)' })
    expect(getLaunch(r.hub, LAUNCH)).toBeNull()
  })
})
