// Issue #412 step 3: `driver-cli.js run <launch id> <hub db>`, the detached
// driver Electron main starts (design §8), end to end against a fake `copilot`
// on the spec's PATH: the spec read from fd 3, the one stdout status line, the
// launch row it writes, Stop, park when idle, resume by session/load, a signed
// approval, and its refusals before anything starts.
import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import type Database from 'better-sqlite3'
import { claimDriverSlot, getLaunch, listItems, openDb, recordLaunchProgress, replyItem, requestLaunchStop } from '../src/store.js'
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
const FAKE_COPILOT = `#!/usr/bin/env node
const fs = require('fs')
const agent = 'https://agentclientprotocol.com/protocol/session-modes#agent'
const config = (mode) => [{ id: 'mode', currentValue: mode }, { id: 'allow_all', currentValue: 'off' }]
// Node uses low fds of its own, so ask a shell it starts, as a tool call would:
// a descriptor copilot inherited is inherited again there
const fd3 = require('child_process').execFileSync('/bin/sh', ['-c', 'if [ -e /dev/fd/3 ]; then echo open; else echo closed; fi']).toString().trim()
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { hooks: process.env.AGENT_INBOX_HOOKS, db: process.env.AGENT_INBOX_DB }, fd3 }) + '\\n')
let buffer = ''
let prompt = null
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
process.stdin.on('end', () => process.exit(0))
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
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, COPILOT_HOME: copilotHome, FAKE_LOG: fakeLog },
  }
}

function newSpec(r: Rig, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, kind: 'new', launchId: LAUNCH, host: 'copilot', cwd: join(r.dir, 'work'), mode: 'ask',
    model: 'claude-haiku-4.5', reasoningEffort: 'none', budgets: { activeMs: 7_200_000, toolCalls: 500 },
    prompt: 'Fix the failing test.', env: r.env, launchKey: LAUNCH_KEY.toString('base64'), ...over,
  }
}

function runDriver(r: Rig, spec: unknown, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', join(REPO, 'src', 'driver-cli.ts'), 'run', LAUNCH, r.db], {
    cwd: REPO,
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
    status: async () => {
      await until(() => stdout.includes('\n'), 'the status line', 20_000)
      return JSON.parse(stdout.split('\n')[0]!) as Record<string, unknown>
    },
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
    })
    expect(requestLaunchStop(r.hub, LAUNCH)).toBe('stopping')
    expect(await run.exited).toBe(0)
    expect(getLaunch(r.hub, LAUNCH)).toMatchObject({ status: 'ended', end_reason: 'stopped' })
    expect(run.output().stdout.trim().split('\n')).toHaveLength(1)
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
    expect(await resume.status()).toEqual({ ok: false, error: `launch ${LAUNCH} is not parked` })
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
  })

  it.each([
    ['a shebang that passes the interpreter flags', (bin: string) => {
      writeFileSync(join(bin, 'copilot'), FAKE_COPILOT.replace('#!/usr/bin/env node', '#!/usr/bin/env node --require=/elsewhere/hook.js'))
    }, /names an interpreter this driver does not resolve/],
    ['a host others can write', (bin: string) => chmodSync(join(bin, 'copilot'), 0o775), /writable by others; refusing to run it/],
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
    expect(await failed.status()).toEqual({ ok: true, launch: LAUNCH })
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
    expect(await resumed.status()).toEqual({ ok: true, launch: LAUNCH })
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
