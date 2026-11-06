// Issue #412, step 2: the driver's state machine against a fake Copilot ACP
// agent that replays the spike's recorded frames (test/acp-fake.ts). The §11
// step-2 list: escalation, allow_all turning on, the option allow-list
// (bypass and unknown ids dropped, allow_always never selected), a load replay
// holding an autopilot update, the mid-turn interrupt, Plan first's phases,
// ordering in both directions, framed prompts and control messages, push once
// with a re-check, answer pings, budgets, Stop and fail-closed.
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import { Driver } from '../src/driver.js'
import { installStopHandlers } from '../src/driver-tty.js'
import type { AskChannel, AskView, DriverHooks, DriverOptions, DriverTiming, EndReason, ScanResult } from '../src/driver.js'
import { appAsks, launchHooks } from '../src/driver-launch.js'
import type { LaunchMode } from '../src/driver-policy.js'
import {
  annotateBoardRow, claimDriverSlot, getBoard, getItem, insertItem, isDrivenSession, listItems, listPending,
  listSessionMessages, openDb, replyItem, requestDriverStop, sendSessionMessage, upsertActivity, upsertBoard,
  withdrawSessionMessage, endActivity, createLaunch, getLaunch, dismissItem, resolveItem, listActivity, requestLaunchInterrupt, requestLaunchPark, handOffForTerminal,
} from '../src/store.js'
import { LAUNCH_KEY, sign } from './launch-fixtures.js'
import { MODE, configUpdate, fakeAgent, permissionRequest, toolCall } from './acp-fake.js'
import type { FakeAgent, FakeScript } from './acp-fake.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const LAUNCH = '11111111-2222-4333-8444-555555555555'
const HOST = 76681
type Json = Record<string, unknown>

const open: Database.Database[] = []
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close()
  removeScratchDirs()
})

async function until<T>(read: () => T | undefined | false | null, label: string, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function presence(db: Database.Database, session: string, over: { server_pid?: number } = {}): void {
  upsertActivity(db, {
    session, project: 'agent-inbox', stream: 'main', agent: 'copilot', doing: 'open', idle: true, claim: false,
    receives_messages: true, host_pid: HOST, server_pid: over.server_pid ?? 76734,
  })
}

interface Harness {
  driver: Driver
  fake: FakeAgent
  human: Database.Database
  done: Promise<EndReason>
  asks: AskView[]
  settled: Array<{ id: string; outcome: string }>
  log: Json[]
  notices: string[]
  dir: string
  scan: { result: ScanResult }
  ready(): Promise<void>
  /** The permission answer the driver sent for a request id. */
  answerTo(id: unknown): Promise<Json>
}

function start(opts: {
  mode?: LaunchMode
  task?: string
  script?: FakeScript
  timing?: Partial<DriverTiming>
  loadSessionId?: string
  linked?: string[]
  /** An app launch: its asks and row (driver-launch.ts) instead of the terminal's. */
  app?: boolean
  refuseLoad?: FakeScript['refuseLoad']
  priorSessions?: DriverOptions['priorSessions']
  usage?: DriverOptions['usage']
} = {}): Harness {
  const dir = scratchDir('driver-')
  const dbPath = join(dir, 'inbox.db')
  const db = openDb(dbPath)
  const human = openDb(dbPath)
  open.push(db, human)
  presence(human, 'mcp-1')
  const lease = { launchId: LAUNCH, pid: process.pid, nonce: 'test' }
  expect(claimDriverSlot(db, lease, 2)).toEqual({ ok: true })
  const fake = fakeAgent({ ...(opts.script ?? { onPrompt: () => undefined }), ...(opts.refuseLoad ? { refuseLoad: opts.refuseLoad } : {}) })
  const asks: AskView[] = []
  const settled: Array<{ id: string; outcome: string }> = []
  const log: Json[] = []
  const notices: string[] = []
  const scan = { result: { hostPid: HOST, linked: opts.linked ?? ['mcp-1'], dead: [] } as ScanResult }
  let app: { asks: AskChannel; hooks: DriverHooks } | undefined
  if (opts.app) {
    createLaunch(db, {
      id: LAUNCH, host: 'copilot', project: 'agent-inbox', stream: 'main', cwd: dir, mode: opts.mode ?? 'ask',
      budgetActiveMs: 7_200_000, budgetToolCalls: 500, prompt: 'Fix the failing test.', specVersion: 1, driverPid: process.pid,
    })
    app = {
      asks: appAsks({ db, launchId: LAUNCH, launchKey: LAUNCH_KEY, project: 'agent-inbox', stream: 'main', log: (e) => log.push(e) }),
      hooks: launchHooks(db, LAUNCH),
    }
  }
  const driver = new Driver({
    db, lease, mode: opts.mode ?? 'ask', cwd: dir, project: 'agent-inbox', stream: 'main',
    task: opts.task ?? 'Fix the failing test.',
    input: fake.stdout, output: fake.stdin, child: { kill: (signal) => fake.kill(signal), exited: fake.exited },
    ui: { ask: (a) => asks.push(a), settled: (id, outcome) => settled.push({ id, outcome }), text: () => undefined, notice: (t) => { notices.push(t) } },
    log: (e) => log.push(e),
    stateDir: join(dir, 'drivers', LAUNCH),
    scan: async () => scan.result,
    timing: { pollMs: 10, scanMs: 10, leaseMs: 40, setupWaitMs: 400, stopGraceMs: 50, ...opts.timing },
    ...(opts.loadSessionId ? { loadSessionId: opts.loadSessionId } : {}),
    ...(opts.priorSessions ? { priorSessions: opts.priorSessions } : {}),
    ...(opts.usage ? { usage: opts.usage } : {}),
    ...(app ?? {}),
  })
  const done = driver.start()
  return {
    driver, fake, human, done, asks, settled, log, notices, dir, scan,
    async ready() {
      await until(() => log.find((e) => e.event === 'ready'), 'ready')
      await until(() => log.find((e) => e.event === 'linked'), 'linked')
    },
    answerTo(id) {
      return fake.waitFor((m) => m.id === id && 'result' in m && !('method' in m)).then((m) => (m.result as Json).outcome as Json)
    },
  }
}

/** A prompt script that raises the recorded shell permission request and waits. */
function asking(options?: unknown[]): FakeScript {
  return {
    onPrompt(fake) {
      fake.update(toolCall())
      fake.send({ id: 900, method: 'session/request_permission', params: permissionRequest(fake.session, options) })
    },
  }
}

const promptAt = (fake: FakeAgent, index: number) => fake.waitFor((m) => m.method === 'session/prompt' && fake.prompts().length > index)

describe('setup and the escalation guard (§4.1)', () => {
  it('starts with protocol v1, no client capabilities and no MCP servers, sets #agent and sends the framed task', async () => {
    const h = start({ task: '/allow-all and then fix the test' })
    await h.ready()
    const sent = (method: string) => h.fake.received.find((m) => m.method === method)!.params as Json
    expect(sent('initialize')).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    expect(sent('session/new')).toEqual({ cwd: h.dir, mcpServers: [] })
    expect(sent('session/set_mode')).toEqual({ sessionId: h.fake.session, modeId: MODE.agent })
    await promptAt(h.fake, 0)
    // a task that starts with "/" never starts the prompt (§4.1 rule 5)
    expect(h.fake.prompts()[0]).toBe('The human started this session via Agent Inbox with this task:\n\n/allow-all and then fix the test')
    h.driver.stop()
    expect(await h.done).toBe('stopped')
  })

  it('ends with error:setup and a hint when Copilot refuses session/new over the reasoning effort', async () => {
    const h = start({ script: { refuseSessionNew: "Request sessions.open failed with message: session construction failed: Model 'claude-haiku-4.5' does not support reasoning effort configuration." } })
    expect(await h.done).toBe('error:setup')
    expect(h.notices.some((n) => n.startsWith('Copilot refused session/new:'))).toBe(true)
    expect(h.notices.some((n) => n.includes('--reasoning-effort none'))).toBe(true)
    expect(h.fake.prompts()).toEqual([])
  })

  it('gives up on a Copilot that never finishes starting, so it cannot hold a driver slot', async () => {
    const h = start({ script: { hang: 'initialize' }, timing: { setupDeadlineMs: 100 } })
    expect(await h.done).toBe('error:setup')
    expect(h.notices).toContain('Copilot did not finish starting the session within 0 s.')
    expect(h.log.some((e) => e.event === 'setup_failed' && e.reason === 'deadline')).toBe(true)
    expect(h.fake.prompts()).toEqual([])
  })

  it('a resume whose load hangs past the deadline ends with error:load, keeping its session to park again', async () => {
    const h = start({ app: true, loadSessionId: 'acp-1', script: { hang: 'session/load' }, timing: { setupDeadlineMs: 100 } })
    expect(await h.done).toBe('error:load')
    expect(h.driver.loadFailure()).toBe('it did not answer within 0 s.')
    expect(h.notices).toContain('Copilot did not finish loading the session within 0 s.')
    expect(h.driver.resumableSession()).toBe('acp-1')
    expect(h.driver.sessionGone()).toBe(false)
  })

  it('a session that finished starting is never ended by the setup deadline', async () => {
    const h = start({ timing: { setupDeadlineMs: 300 } })
    await h.ready()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(h.log.some((e) => e.event === 'setup_failed')).toBe(false)
    h.driver.stop()
    expect(await h.done).toBe('stopped')
  })

  it('ends the launch when the mode leaves the allowed set mid-turn, cancelling the turn and its open request', async () => {
    const h = start({ script: asking() })
    await h.ready()
    await until(() => h.asks[0], 'the ask')
    h.fake.update({ sessionUpdate: 'current_mode_update', currentModeId: MODE.autopilot })
    expect(await h.done).toBe('error:mode_escalation')
    expect(await h.answerTo(900)).toEqual({ outcome: 'cancelled' })
    expect(h.fake.received.some((m) => m.method === 'session/cancel')).toBe(true)
    expect(h.settled).toEqual([{ id: h.asks[0]!.id, outcome: 'Session ended (error:mode_escalation).' }])
  })

  it('ends the launch when allow_all turns on, as /allow-all does, even with the mode unchanged', async () => {
    const h = start()
    await h.ready()
    await promptAt(h.fake, 0)
    h.fake.update(configUpdate(MODE.agent, 'on'))
    expect(await h.done).toBe('error:mode_escalation')
    expect(h.log.find((e) => e.event === 'mode_escalation')).toMatchObject({ allow_all: 'on' })
  })

  it('moves a new session that starts in autopilot to #agent and verifies allow_all off before prompting', async () => {
    const h = start({ script: { onPrompt: () => undefined, initial: { mode: MODE.autopilot, allowAll: 'on' } } })
    await h.ready()
    expect(h.log.find((e) => e.event === 'session')).toMatchObject({ mode: MODE.autopilot, allow_all: 'on' })
    expect(h.log.find((e) => e.event === 'ready')).toMatchObject({ mode: MODE.agent, allow_all: 'off' })
    h.driver.stop()
    await h.done
  })

  it('ignores a load’s replayed history, autopilot update included, then sets and verifies #agent', async () => {
    const h = start({
      loadSessionId: '57b24380-5e36-4758-89a3-69f04ce06a40',
      script: { onPrompt: () => undefined, initial: { mode: MODE.autopilot, allowAll: 'on' }, loadReplay: true },
    })
    await h.ready()
    expect(h.log.some((e) => e.event === 'mode_escalation')).toBe(false)
    expect(h.fake.received.find((m) => m.method === 'session/load')!.params).toMatchObject({ sessionId: '57b24380-5e36-4758-89a3-69f04ce06a40', mcpServers: [] })
    expect(h.log.find((e) => e.event === 'ready')).toMatchObject({ mode: MODE.agent, allow_all: 'off' })
    h.driver.stop()
    expect(await h.done).toBe('stopped')
  })

  it('re-asserts allow_all off once when set_mode leaves it on, and continues only once an update verifies off', async () => {
    const h = start({ script: { onPrompt: () => undefined, initial: { mode: MODE.agent, allowAll: 'on' }, keepAllowAll: true } })
    await h.ready()
    expect(h.fake.received.filter((m) => m.method === 'session/set_config_option').map((m) => m.params))
      .toEqual([{ sessionId: h.fake.session, configId: 'allow_all', value: 'off' }])
    h.driver.stop()
    await h.done
  })

  it('ends the launch when allow_all cannot be verified off, before any prompt', async () => {
    const h = start({ script: { onPrompt: () => undefined, initial: { mode: MODE.agent, allowAll: 'on' }, keepAllowAll: true, ignoreAllowAllOff: true } })
    expect(await h.done).toBe('error:mode_escalation')
    expect(h.fake.received.filter((m) => m.method === 'session/set_config_option')).toHaveLength(1)
    expect(h.fake.prompts()).toEqual([])
  })
})

describe('approvals: the option allow-list, the @sessions alert and the terminal (§4.1–4.3)', () => {
  it('drops bypass, auto and unknown options, never selects allow_always, and answers an approval allow_once', async () => {
    const offered = [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'bypassPermissions', kind: 'allow_always', name: 'Yes, and bypass permissions' },
      { optionId: 'auto', kind: 'allow_once', name: 'Yes, and auto' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
    ]
    const h = start({ script: asking(offered) })
    await h.ready()
    const ask = await until(() => h.asks[0], 'the ask')
    expect(ask).toMatchObject({ kind: 'permission', title: 'Allow copilot to run `echo acp-perm-probe`?' })
    expect(h.log.find((e) => e.event === 'permission_request')).toMatchObject({
      allow: 'allow_once', reject: 'reject_once', dropped: ['allow_always', 'bypassPermissions', 'auto'],
    })
    // the alert: an @sessions task item under the agent's own MCP session, invisible to its project
    const alert = listItems(h.human).find((item) => item.project === '@sessions')!
    expect(alert).toMatchObject({
      status: 'open', kind: 'question', session: 'mcp-1', agent: 'copilot', action_owner: 'task', options: null,
      stream: 'agent-inbox · main', title: 'Allow copilot to run `echo acp-perm-probe`?', next_step: 'Answer in the terminal running the driver.',
    })
    expect(alert.context).toContain('Declining stops the agent’s current turn.')
    expect(listPending(h.human, 'agent-inbox')).toEqual([])
    h.driver.answer(ask.id, true)
    expect(await h.answerTo(900)).toEqual({ outcome: 'selected', optionId: 'allow_once' })
    await until(() => getItem(h.human, alert.id)!.status === 'resolved', 'the alert resolved')
    expect(h.settled).toEqual([{ id: ask.id, outcome: 'Allowed once in the terminal.' }])
    expect(h.fake.received.some((m) => JSON.stringify(m).includes('"allow_always"'))).toBe(false)
    h.driver.stop()
    await h.done
  })

  it('answers a decline reject_once, which on Copilot ends the turn', async () => {
    const h = start({ script: asking() })
    await h.ready()
    const ask = await until(() => h.asks[0], 'the ask')
    h.driver.answer(ask.id, false)
    expect(await h.answerTo(900)).toEqual({ outcome: 'selected', optionId: 'reject_once' })
    expect(h.settled[0]!.outcome).toBe('Declined in the terminal; the agent’s turn stopped.')
    h.driver.stop()
    await h.done
  })

  it('files no ask when no allowed option survives, and answers with the reject option', async () => {
    const h = start({ script: asking([
      { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'mystery', kind: 'allow_once', name: '???' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
    ]) })
    await h.ready()
    expect(await h.answerTo(900)).toEqual({ outcome: 'selected', optionId: 'reject_once' })
    expect(h.asks).toEqual([])
    expect(listItems(h.human).filter((item) => item.project === '@sessions')).toEqual([])
    h.driver.stop()
    await h.done
  })
})

describe('ordering: one queue for frames and approvals (§4.1, Ordering)', () => {
  it('a config update that arrives before the approval moves the generation, so the approval answers reject_once', async () => {
    const h = start({ script: asking() })
    await h.ready()
    const ask = await until(() => h.asks[0], 'the ask')
    // nothing changes but the generation (Copilot re-sends the same values)
    h.fake.update(configUpdate(MODE.agent, 'off'))
    await until(() => h.log.filter((e) => e.event === 'config_update').length > 1, 'the update applied')
    h.driver.answer(ask.id, true)
    expect(await h.answerTo(900)).toEqual({ outcome: 'selected', optionId: 'reject_once' })
    expect(h.settled[0]!.outcome).toBe('Not applied: the session’s permissions changed while you were answering.')
    h.driver.stop()
    await h.done
  })

  it('an approval that lands while an update is already queued waits behind it and is re-validated', async () => {
    const h = start({ script: asking() })
    await h.ready()
    const ask = await until(() => h.asks[0], 'the ask')
    // the update is read (queued) before the intent in the same tick; neither is handled yet
    h.fake.update({ sessionUpdate: 'current_mode_update', currentModeId: MODE.agent })
    h.driver.answer(ask.id, true)
    expect(await h.answerTo(900)).toEqual({ outcome: 'selected', optionId: 'reject_once' })
    h.driver.stop()
    await h.done
  })

  it('an escalation queued ahead of an approval ends the launch first: the request is cancelled, never allowed', async () => {
    const h = start({ script: asking() })
    await h.ready()
    const ask = await until(() => h.asks[0], 'the ask')
    h.fake.update(configUpdate(MODE.agent, 'on'))
    h.driver.answer(ask.id, true)
    expect(await h.done).toBe('error:mode_escalation')
    expect(await h.answerTo(900)).toEqual({ outcome: 'cancelled' })
    expect(h.fake.received.filter((m) => m.id === 900).map((m) => m.result)).toEqual([{ outcome: { outcome: 'cancelled' } }])
  })
})

describe('Plan first (§4.1 phases)', () => {
  const planned: FakeScript = {
    onPrompt(fake, id) {
      fake.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Plan written.' } })
      fake.respond(id, { stopReason: 'end_turn' })
    },
  }

  it('starts in #plan, asks to approve the plan when a turn ends there, and ends the launch on an unsolicited #agent', async () => {
    const h = start({ mode: 'plan', script: planned })
    await h.ready()
    expect(h.fake.received.find((m) => m.method === 'session/set_mode')!.params).toMatchObject({ modeId: MODE.plan })
    const ask = await until(() => h.asks.find((a) => a.kind === 'plan'), 'the plan ask')
    expect(ask.title).toBe('Approve the plan and continue?')
    h.fake.update({ sessionUpdate: 'current_mode_update', currentModeId: MODE.agent })
    expect(await h.done).toBe('error:mode_escalation')
    expect(h.fake.received.filter((m) => m.method === 'session/set_mode')).toHaveLength(1)
  })

  it('after approval sends exactly one set_mode #agent, accepts only its result, sends the control prompt, and ends on a later #plan', async () => {
    const h = start({ mode: 'plan', script: planned })
    await h.ready()
    const ask = await until(() => h.asks.find((a) => a.kind === 'plan'), 'the plan ask')
    h.driver.answer(ask.id, true)
    await until(() => h.fake.prompts().length === 2, 'the control prompt')
    expect(h.fake.received.filter((m) => m.method === 'session/set_mode').map((m) => (m.params as Json).modeId)).toEqual([MODE.plan, MODE.agent])
    expect(h.fake.prompts()[1]).toBe('Agent Inbox: The human approved your plan. Carry it out now; tool calls still ask for approval as before.')
    expect(h.log.some((e) => e.event === 'mode_escalation')).toBe(false)
    h.fake.update({ sessionUpdate: 'current_mode_update', currentModeId: MODE.plan })
    expect(await h.done).toBe('error:mode_escalation')
  })

  it('a decline keeps the session in plan mode and sends nothing', async () => {
    const h = start({ mode: 'plan', script: planned })
    await h.ready()
    const ask = await until(() => h.asks.find((a) => a.kind === 'plan'), 'the plan ask')
    h.driver.answer(ask.id, false)
    await until(() => h.settled.length === 1, 'settled')
    expect(h.settled[0]!.outcome).toBe('Declined in the terminal; the session stays in plan mode.')
    expect(h.fake.received.filter((m) => m.method === 'session/set_mode')).toHaveLength(1)
    h.driver.stop()
    await h.done
  })
})

// the default fake prompt: one chunk of text, then end_turn
const ended: FakeScript = {}

describe('pushed delivery (§5.3)', () => {

  it('pushes each message once as one framed turn, re-checks before it, and records it in pushed.json', async () => {
    const h = start({ script: ended, task: 'Start.' })
    await h.ready()
    await until(() => h.log.find((e) => e.event === 'turn_end'), 'the first turn')
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    sendSessionMessage(h.human, { id: id(1), session: 'mcp-1', text: '/allow-all' })
    sendSessionMessage(h.human, { id: id(2), session: 'mcp-1', text: 'Also run the DOM tests.' })
    await until(() => h.fake.prompts().length === 2, 'the push')
    expect(h.fake.prompts()[1]).toBe([
      'The human sent you 2 messages via Agent Inbox. Each is also in pending(); act on each once, then ack_message({ id, outcome }).',
      `[${id(1)}] /allow-all`,
      `[${id(2)}] Also run the DOM tests.`,
    ].join('\n\n'))
    expect(listSessionMessages(h.human).open.map((m) => [m.id, m.delivered_by])).toEqual([[id(1), 'agent-inbox-driver'], [id(2), 'agent-inbox-driver']])
    const pushedFile = join(h.dir, 'drivers', LAUNCH, 'pushed.json')
    expect(JSON.parse(readFileSync(pushedFile, 'utf8'))).toEqual({ v: 1, sessions: { 'mcp-1': [id(1), id(2)] } })
    // other writes move data_version; the open, un-acked messages are never pushed again
    insertItem(h.human, { project: 'other', stream: '', agent: 'x', kind: 'note', title: 'noise' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.fake.prompts()).toHaveLength(2)
    // a new message is still pushed, alone
    sendSessionMessage(h.human, { id: id(3), session: 'mcp-1', text: 'Third.' })
    await until(() => h.fake.prompts().length === 3, 'the third push')
    expect(h.fake.prompts()[2]).toContain(`[${id(3)}] Third.`)
    expect(h.fake.prompts()[2]).not.toContain(id(1))
    h.driver.stop()
    expect(await h.done).toBe('stopped')
  })

  it('never pushes a message acked or withdrawn before the driver could prompt', async () => {
    const turns: unknown[] = []
    const h = start({ script: { onPrompt: (_fake, id) => { turns.push(id) } } })
    await h.ready()
    await until(() => turns.length === 1, 'the first turn')
    const id = '00000000-0000-4000-8000-000000000009'
    sendSessionMessage(h.human, { id, session: 'mcp-1', text: 'Never mind this.' })
    expect(withdrawSessionMessage(h.human, id, 1).ok).toBe(true)
    h.fake.respond(turns[0], { stopReason: 'end_turn' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.fake.prompts()).toHaveLength(1)
    h.driver.stop()
    await h.done
  })

  it('queues messages while a turn runs, and Interrupt and send cancels, waits for the turn, then sends the framed notice', async () => {
    const turns: unknown[] = []
    const h = start({ script: { onPrompt: (_fake, id) => { turns.push(id) } } })
    await h.ready()
    await until(() => turns.length === 1, 'the first turn')
    const id = '00000000-0000-4000-8000-000000000001'
    sendSessionMessage(h.human, { id, session: 'mcp-1', text: 'Stop and run lint instead.' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    // no second session/prompt mid-turn: Copilot would cancel the running turn (spike §3)
    expect(h.fake.prompts()).toHaveLength(1)
    h.driver.interrupt()
    await until(() => h.fake.prompts().length === 2, 'the interrupt turn')
    const cancel = h.fake.received.findIndex((m) => m.method === 'session/cancel')
    const second = h.fake.received.findIndex((m) => m.method === 'session/prompt' && m.id !== h.fake.received.find((p) => p.method === 'session/prompt')!.id)
    expect(cancel).toBeGreaterThan(-1)
    expect(cancel).toBeLessThan(second)
    expect(h.log.find((e) => e.event === 'turn_end')).toMatchObject({ stopReason: 'cancelled' })
    expect(h.fake.prompts()[1]).toBe(`Agent Inbox: The human interrupted your previous turn.\n\nThe human sent you 1 message via Agent Inbox. Each is also in pending(); act on each once, then ack_message({ id, outcome }).\n\n[${id}] Stop and run lint instead.`)
    h.driver.stop()
    await h.done
  })

  it('shows its turn to the composer, and takes Interrupt and send from the page (#412 step 3, §5.3)', async () => {
    const turns: unknown[] = []
    const h = start({ app: true, script: { onPrompt: (_fake, id) => { turns.push(id) } } })
    await h.ready()
    await until(() => turns.length === 1, 'the first turn')
    const row = () => listActivity(h.human).find((a) => a.session === 'mcp-1')!
    await until(() => row().driven_turn, 'the turn state')
    expect(row()).toMatchObject({ driven: true, driven_launch: LAUNCH, driven_turn: { state: 'turn' } })
    const id = '00000000-0000-4000-8000-000000000011'
    sendSessionMessage(h.human, { id, session: 'mcp-1', text: 'Stop and run lint instead.' })
    expect(requestLaunchInterrupt(h.human, LAUNCH)).toBe(true)
    await until(() => h.fake.prompts().length === 2, 'the interrupt turn')
    expect(h.fake.prompts()[1]).toContain('The human interrupted your previous turn.')
    expect(h.fake.prompts()[1]).toContain(`[${id}] Stop and run lint instead.`)
    // the request is taken once
    expect(requestLaunchInterrupt(h.human, 'not-a-launch')).toBe(false)
    h.fake.respond(turns[1], { stopReason: 'end_turn' })
    await until(() => !row().driven_turn, 'the turn state cleared')
    h.driver.stop()
    await h.done
    // its leases go with it: no turn state, no interrupt left behind
    expect(row()?.driven_turn).toBeUndefined()
  })

  it('Park now during a resume’s setup waits until it is ready, and keeps the session to load (review of #433)', async () => {
    let release!: () => void
    const holdLoad = new Promise<void>((resolve) => { release = resolve })
    const h = start({ app: true, loadSessionId: 'acp-1', script: { holdLoad } })
    // before the load has answered, the session the resume holds is still the one to keep
    expect(h.driver.resumableSession()).toBe('acp-1')
    await until(() => h.fake.received.find((m) => m.method === 'session/load'), 'the load')
    expect(requestLaunchPark(h.human, LAUNCH)).toBe(true)
    await until(() => h.log.find((e) => e.event === 'park_requested'), 'the request taken')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.log.find((e) => e.event === 'ending')).toBeUndefined()
    release()
    expect(await h.done).toBe('park')
    expect(h.log.find((e) => e.event === 'ready')).toBeDefined()
    expect(h.driver.resumableSession()).toBe('acp-1')
    expect(h.driver.sessionGone()).toBe(false)
  })

  it('Take over waits until a resume’s session is loaded and set up, then hands it off (step 5)', async () => {
    let release!: () => void
    const holdLoad = new Promise<void>((resolve) => { release = resolve })
    const h = start({ app: true, loadSessionId: 'acp-1', script: { holdLoad } })
    await until(() => h.fake.received.find((m) => m.method === 'session/load'), 'the load')
    expect(handOffForTerminal(h.human, LAUNCH)).toEqual({ ok: true, state: 'requested' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    // not taken before Copilot answered the load: there is nothing to resume in a terminal yet
    expect(h.log.find((e) => e.event === 'handoff_requested')).toBeUndefined()
    release()
    expect(await h.done).toBe('handed_off')
    expect(h.log.find((e) => e.event === 'ready')).toBeDefined()
    expect(h.driver.resumableSession()).toBe('acp-1')
  })

  it('Park now waits for the running turn to end, then ends as the idle park does (#412 step 3, PR 4)', async () => {
    const turns: unknown[] = []
    const h = start({ app: true, script: { onPrompt: (_fake, id) => { turns.push(id) } } })
    await h.ready()
    await until(() => turns.length === 1, 'the first turn')
    expect(requestLaunchPark(h.human, LAUNCH)).toBe(true)
    await until(() => h.log.find((e) => e.event === 'park_requested'), 'the request taken')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.log.find((e) => e.event === 'ending')).toBeUndefined()
    h.fake.respond(turns[0], { stopReason: 'end_turn' })
    expect(await h.done).toBe('park')
  })

  it('pings once when the human answers the session’s own question or a row of a plan it wrote, never another session’s', async () => {
    const h = start({ script: ended })
    await h.ready()
    await until(() => h.log.find((e) => e.event === 'turn_end'), 'the first turn')
    const own = insertItem(h.human, { project: 'agent-inbox', stream: 'main', agent: 'copilot', session: 'mcp-1', kind: 'question', title: "Which 'pool'?\nReally" })
    insertItem(h.human, { project: 'agent-inbox', stream: 'main', agent: 'copilot', session: 'mcp-9', kind: 'question', title: 'Not mine' })
    replyItem(h.human, own, 'tank')
    for (const item of listItems(h.human).filter((i) => i.title === 'Not mine')) replyItem(h.human, item.id, 'x')
    await until(() => h.fake.prompts().length === 2, 'the ping')
    expect(h.fake.prompts()[1]).toBe("Agent Inbox: The human answered 'Which ’pool’? Really'; call pending().")
    // a plan this session wrote, and one another session wrote
    for (const [title, session] of [['Mine', 'mcp-1'], ['Theirs', 'mcp-9']] as const) {
      upsertBoard(h.human, {
        project: 'agent-inbox', stream: 'main', agent: 'copilot', title, session,
        rows: [{ label: `${title} step`, status: 'blocked', action_owner: 'task', note: 'Waiting.', next_step: 'Do it.' }],
      })
      const board = getBoard(h.human, 'agent-inbox', title)!
      annotateBoardRow(h.human, board.rows[0]!.id, 'done', 'answer', board.rows[0]!.revision, board.revision)
    }
    await until(() => h.fake.prompts().length === 3, 'the row ping')
    expect(h.fake.prompts()[2]).toBe("Agent Inbox: The human answered 'Mine step'; call pending().")
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.fake.prompts()).toHaveLength(3)
    h.driver.stop()
    await h.done
  })

  it('re-addresses an ended session’s open messages to the launch’s new server, and its pushed ids with them', async () => {
    const h = start({ script: ended })
    await h.ready()
    await until(() => h.log.find((e) => e.event === 'turn_end'), 'the first turn')
    const id = '00000000-0000-4000-8000-000000000005'
    sendSessionMessage(h.human, { id, session: 'mcp-1', text: 'Keep going.' })
    await until(() => h.fake.prompts().length === 2, 'the push')
    // Copilot restarted its MCP server: a new session under the same native host
    presence(h.human, 'mcp-2', { server_pid: 76900 })
    endActivity(h.human, 'mcp-1')
    h.scan.result = { hostPid: HOST, linked: ['mcp-2'], dead: [] }
    await until(() => h.log.find((e) => e.event === 'readdress'), 'readdress')
    await until(() => isDrivenSession(h.human, 'mcp-2') && !isDrivenSession(h.human, 'mcp-1'), 'the leases moved')
    expect(listSessionMessages(h.human).open.map((m) => [m.id, m.session])).toEqual([[id, 'mcp-2']])
    expect(JSON.parse(readFileSync(join(h.dir, 'drivers', LAUNCH, 'pushed.json'), 'utf8')).sessions['mcp-2']).toEqual([id])
    await new Promise((resolve) => setTimeout(resolve, 60))
    // pushed once per launch: not again after the move
    expect(h.fake.prompts()).toHaveLength(2)
    h.driver.stop()
    await h.done
  })
})

describe('budgets, Stop and failing closed (§7)', () => {
  it('ends at the tool-call budget', async () => {
    const h = start({
      timing: { maxToolCalls: 2 },
      script: { onPrompt(fake) { fake.update(toolCall()); fake.update(toolCall()) } },
    })
    expect(await h.done).toBe('budget:tool_calls')
    expect(h.fake.received.some((m) => m.method === 'session/cancel')).toBe(true)
  })

  it('ends at the active-time budget, counting only turn time', async () => {
    const h = start({ timing: { activeMs: 60 }, script: { onPrompt: () => undefined } })
    expect(await h.done).toBe('budget:active_time')
  })

  it('#479: with no limit, the default, neither tool calls nor turn time end it, and both are still counted', async () => {
    const h = start({ script: { onPrompt(fake) { for (let i = 0; i < 501; i++) fake.update(toolCall()) } } })
    await until(() => h.driver.usage().toolCalls === 501, '501 tool calls')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.driver.usage().toolCalls).toBe(501)
    expect(h.log.some((e) => e.event === 'ended')).toBe(false)
    h.driver.stop()
    expect(await h.done).toBe('stopped')
  })

  it('ends after the idle limit, with no park in step 2', async () => {
    const h = start({ timing: { idleMs: 60 }, script: ended })
    expect(await h.done).toBe('idle')
  })

  it('stops on the runtime CLI’s stop lease: open requests cancelled, alerts resolved “Session stopped”, leases released', async () => {
    const h = start({ script: asking() })
    await h.ready()
    const ask = await until(() => h.asks[0], 'the ask')
    expect(isDrivenSession(h.human, 'mcp-1')).toBe(true)
    requestDriverStop(h.human, LAUNCH)
    expect(await h.done).toBe('stopped')
    expect(await h.answerTo(900)).toEqual({ outcome: 'cancelled' })
    expect(h.settled).toEqual([{ id: ask.id, outcome: 'Session stopped.' }])
    expect(listItems(h.human).find((i) => i.project === '@sessions')!.status).toBe('resolved')
    expect(isDrivenSession(h.human, 'mcp-1')).toBe(false)
    expect(h.fake.received.some((m) => m.method === 'session/cancel')).toBe(true)
  })

  it('fails closed when it cannot read the hub', async () => {
    const h = start({ timing: { hubFailMs: 40 }, script: asking() })
    await h.ready()
    await until(() => h.asks[0], 'the ask')
    open[0]!.close() // the driver's own connection
    expect(await h.done).toBe('error:hub_unreachable')
    expect(await h.answerTo(900)).toEqual({ outcome: 'cancelled' })
  })
})

describe('the terminal going away (#412 review)', () => {
  function wire(h: Harness) {
    const signals = new EventEmitter()
    const input = new EventEmitter()
    const exits: number[] = []
    installStopHandlers({ signals, input, driver: h.driver, exit: (code) => exits.push(code), notice: () => undefined, silence: () => undefined, boundMs: 2000 })
    return { signals, input, exits }
  }
  const alerts = (h: Harness) => listItems(h.human).filter((item) => item.project === '@sessions')

  it.each(['SIGHUP', 'SIGTERM'] as const)('%s ends the launch with its asks resolved and its leases released', async (signal) => {
    const h = start({ script: asking() })
    await h.ready()
    await until(() => h.asks[0], 'the ask')
    const rig = wire(h)
    rig.signals.emit(signal)
    expect(await h.done).toBe('stopped')
    expect(await h.answerTo(900)).toEqual({ outcome: 'cancelled' })
    expect(alerts(h).map((item) => [item.status, item.outcome])).toEqual([['resolved', 'Session stopped.']])
    expect(isDrivenSession(h.human, 'mcp-1')).toBe(false)
    expect(claimDriverSlot(h.human, { launchId: '22222222-2222-4333-8444-555555555555', pid: 4243, nonce: 'next' }, 1)).toEqual({ ok: true })
    expect(rig.exits).toEqual([])
  })

  it('a closed terminal input ends the launch the same way', async () => {
    const h = start({ script: asking() })
    await h.ready()
    await until(() => h.asks[0], 'the ask')
    wire(h).input.emit('close')
    expect(await h.done).toBe('stopped')
    expect(alerts(h)[0]!.status).toBe('resolved')
  })

  it('a double Ctrl-C resolves the asks, releases the leases and signals the child before exiting, synchronously', async () => {
    const h = start({ script: asking() })
    await h.ready()
    await until(() => h.asks[0], 'the ask')
    let killed: string | null = null
    h.fake.kill = (signal) => { killed = signal }
    const rig = wire(h)
    rig.signals.emit('SIGINT')
    rig.signals.emit('SIGINT')
    // no await between the second Ctrl-C and these checks: the cleanup ran before exit
    expect(rig.exits).toEqual([130])
    expect(alerts(h).map((item) => [item.status, item.outcome])).toEqual([['resolved', 'Session stopped.']])
    expect(isDrivenSession(h.human, 'mcp-1')).toBe(false)
    expect(h.driver.isFinished()).toBe(true)
    expect(await h.done).toBe('stopped')
    expect(await h.answerTo(900)).toEqual({ outcome: 'cancelled' })
    h.driver.forceStop() // idempotent
    expect(killed).toBe('SIGTERM')
  })
})

describe('a child that outlives the driver (#412 review, round 2)', () => {
  it('a second Ctrl-C after the driver finished still sends the child’s group SIGTERM', async () => {
    const h = start({ script: { onPrompt: () => undefined, ignoreStdinClose: true }, timing: { stopGraceMs: 5000 } })
    await h.ready()
    const kills: string[] = []
    h.fake.kill = (signal) => { kills.push(signal) }
    const signals = new EventEmitter()
    const exits: number[] = []
    installStopHandlers({ signals, input: new EventEmitter(), driver: h.driver, exit: (code) => exits.push(code), notice: () => undefined, silence: () => undefined })
    h.driver.stop()
    expect(await h.done).toBe('stopped')
    expect(h.driver.isFinished()).toBe(true)
    signals.emit('SIGINT')
    signals.emit('SIGINT')
    expect(kills).toEqual(['SIGTERM'])
    expect(exits).toEqual([130])
    // once the child has exited, nothing is signalled
    h.fake.exit()
    await new Promise((resolve) => setImmediate(resolve))
    h.driver.forceStop()
    expect(kills).toEqual(['SIGTERM'])
  })
})

// Issue #412 step 3: an app launch's asks are approved only by a reply Electron
// main signed under the launch's key (§4.3), and its driver reports to the
// launch row, parks when idle and resumes by loading its session (§6, §7).
describe('app launches: signed approvals (§4.3)', () => {
  const askItem = (h: Harness) => until(() => listItems(h.human).find((item) => item.project === '@sessions' && item.status === 'open'), 'the ask')

  it('files an approval ask in @sessions with its choices, and a signed allow_once answers allow_once', async () => {
    const h = start({ app: true, script: asking() })
    await h.ready()
    const item = await askItem(h)
    expect(item).toMatchObject({
      kind: 'question', action_owner: 'approval', session: 'mcp-1', next_step: 'Approve or decline in the Agent Inbox app.',
      options: [{ label: 'Allow once', detail: 'Lets this one tool call run. Later calls still ask.' }, { label: 'Deny', detail: 'Declining stops the agent’s current turn.' }],
    })
    replyItem(h.human, item.id, 'allow_once', sign(LAUNCH_KEY, item.id, 0, 'allow_once'))
    expect(await h.answerTo(900)).toEqual({ outcome: 'selected', optionId: 'allow_once' })
    await until(() => getItem(h.human, item.id)!.status === 'resolved', 'resolved')
    expect(getItem(h.human, item.id)!.outcome).toBe('Allowed once in Agent Inbox.')
    expect(h.human.prepare(`SELECT COUNT(*) FROM launch_asks`).pluck().get()).toBe(0)
    h.driver.stop()
    await h.done
  })

  it('a mapped ask closed without a valid answer (an older viewer, a hand edit) is declined, never left waiting', async () => {
    const h = start({ app: true, script: asking() })
    await h.ready()
    const item = await askItem(h)
    // an unsigned reply, then a Dismiss from a viewer that does not refuse it
    replyItem(h.human, item.id, 'allow_once')
    dismissItem(h.human, item.id)
    expect(await h.answerTo(900)).toEqual({ outcome: 'selected', optionId: 'reject_once' })
    await until(() => getItem(h.human, item.id)!.outcome !== '', 'settled')
    expect(getItem(h.human, item.id)!.outcome).toBe('Closed without an approval; the agent’s turn stopped.')
    expect(h.log.find((e) => e.event === 'ask_closed')).toMatchObject({ item: item.id, status: 'dismissed' })
    expect(h.human.prepare(`SELECT COUNT(*) FROM launch_asks`).pluck().get()).toBe(0)
    h.driver.stop()
    await h.done
  })

  it('a closed plan ask keeps the session in plan mode', async () => {
    const h = start({ app: true, mode: 'plan', script: { onPrompt(fake, id) { fake.respond(id, { stopReason: 'end_turn' }) } } })
    await h.ready()
    const item = await askItem(h)
    resolveItem(h.human, item.id)
    await until(() => h.log.find((e) => e.event === 'ask_closed'), 'closed')
    await until(() => getItem(h.human, item.id)!.outcome !== '', 'settled')
    expect(getItem(h.human, item.id)!.outcome).toBe('Closed without an approval; the session stays in plan mode.')
    expect(h.fake.received.filter((m) => m.method === 'session/set_mode')).toHaveLength(1)
    h.driver.stop()
    await h.done
  })

  it('a signed decline answers reject_once', async () => {
    const h = start({ app: true, script: asking() })
    await h.ready()
    const item = await askItem(h)
    replyItem(h.human, item.id, 'reject_once', sign(LAUNCH_KEY, item.id, 0, 'reject_once'))
    expect(await h.answerTo(900)).toEqual({ outcome: 'selected', optionId: 'reject_once' })
    h.driver.stop()
    await h.done
  })

  it('never answers on an unsigned, forged, replayed or foreign reply: the ask stays open until main signs it', async () => {
    const h = start({ app: true, script: asking() })
    await h.ready()
    const item = await askItem(h)
    const refusals = () => h.log.filter((e) => e.event === 'approval_refused').length
    const other = Buffer.alloc(32, 9)
    // the ordinary reply route (an older viewer, a browser): no signature
    replyItem(h.human, item.id, 'allow_once')
    await until(() => refusals() === 1, 'refused unsigned')
    // a signature under another launch's key, over another revision, another item, or another option
    replyItem(h.human, item.id, 'allow_once', sign(other, item.id, 0, 'allow_once'))
    await until(() => refusals() === 2, 'refused foreign key')
    replyItem(h.human, item.id, 'allow_once', sign(LAUNCH_KEY, item.id, 1, 'allow_once'))
    await until(() => refusals() === 3, 'refused other revision')
    replyItem(h.human, item.id, 'allow_once', sign(LAUNCH_KEY, 'another-item', 0, 'allow_once'))
    await until(() => refusals() === 4, 'refused other item')
    replyItem(h.human, item.id, 'allow_always', sign(LAUNCH_KEY, item.id, 0, 'allow_always'))
    await until(() => refusals() === 5, 'refused an option the ask does not offer')
    expect(h.log.filter((e) => e.event === 'approval_refused').map((e) => e.why)).toEqual(['signature', 'signature', 'signature', 'signature', 'option'])
    expect(h.fake.received.some((m) => m.id === 900 && 'result' in m)).toBe(false)
    expect(getItem(h.human, item.id)!.status).toBe('open')
    // then main's own signature over the revision at filing approves it
    replyItem(h.human, item.id, 'allow_once', sign(LAUNCH_KEY, item.id, 0, 'allow_once'))
    expect(await h.answerTo(900)).toEqual({ outcome: 'selected', optionId: 'allow_once' })
    h.driver.stop()
    await h.done
  })

  it('re-validates a signed approval like a terminal one: a config update read first makes it answer reject_once', async () => {
    const h = start({ app: true, script: asking() })
    await h.ready()
    const item = await askItem(h)
    h.fake.update(configUpdate(MODE.agent, 'off'))
    await until(() => h.log.filter((e) => e.event === 'config_update').length >= 2, 'the update read')
    replyItem(h.human, item.id, 'allow_once', sign(LAUNCH_KEY, item.id, 0, 'allow_once'))
    expect(await h.answerTo(900)).toEqual({ outcome: 'selected', optionId: 'reject_once' })
    expect(getItem(h.human, item.id)!.outcome).toBe('Not applied: the session’s permissions changed while you were answering.')
    h.driver.stop()
    await h.done
  })

  it('Plan first: a signed approval of the plan switches to #agent and sends the control prompt', async () => {
    const h = start({ app: true, mode: 'plan', script: { onPrompt(fake, id) { fake.respond(id, { stopReason: 'end_turn' }) } } })
    await h.ready()
    const item = await askItem(h)
    expect(item.title).toBe('Approve the plan and continue?')
    replyItem(h.human, item.id, 'approve', sign(LAUNCH_KEY, item.id, 0, 'approve'))
    await until(() => h.fake.prompts().length === 2, 'the control prompt')
    expect(h.fake.prompts()[1]).toBe('Agent Inbox: The human approved your plan. Carry it out now; tool calls still ask for approval as before.')
    expect(getItem(h.human, item.id)!.outcome).toBe('Approved in Agent Inbox.')
    h.driver.stop()
    await h.done
  })
})

describe('app launches: the row, park and resume (§6, §7)', () => {
  it('counts its budgets from the launch’s usage so far: a resumed launch ends at the original total', async () => {
    const h = start({
      app: true, loadSessionId: 'acp-1', linked: [], usage: { activeMs: 0, toolCalls: 4 }, timing: { maxToolCalls: 5 },
      script: { onPrompt(fake) { fake.update(toolCall()) } },
    })
    await until(() => h.log.find((e) => e.event === 'ready'), 'ready')
    h.fake.update(toolCall())
    expect(await h.done).toBe('budget:tool_calls')
    expect(h.driver.usage().toolCalls).toBe(5)
    expect(getLaunch(h.human, LAUNCH)!.tool_calls).toBe(0)
  })

  it('a resumed launch already at a budget ends at once, before any prompt', async () => {
    for (const [usage, reason] of [[{ activeMs: 0, toolCalls: 5 }, 'budget:tool_calls'], [{ activeMs: 60_000, toolCalls: 0 }, 'budget:active_time']] as const) {
      const h = start({ app: true, loadSessionId: 'acp-1', script: ended, usage, timing: { maxToolCalls: 5, activeMs: 60_000 } })
      expect(await h.done).toBe(reason)
      expect(h.fake.prompts()).toEqual([])
    }
  })

  it('a load refused as never prompted (-32002) starts a fresh session and sends the stored task', async () => {
    const h = start({ app: true, script: ended, loadSessionId: 'never-prompted', refuseLoad: { code: -32002, message: 'Resource not found' } })
    await h.ready()
    await until(() => h.fake.prompts().length === 1, 'the task')
    expect(h.fake.received.map((m) => m.method).filter((m) => m === 'session/load' || m === 'session/new')).toEqual(['session/load', 'session/new'])
    expect(h.fake.prompts()[0]).toContain('Fix the failing test.')
    expect(h.log.some((e) => e.event === 'load_not_found')).toBe(true)
    expect(h.driver.loadFailure()).toBeNull()
    h.driver.stop()
    await h.done
    expect(h.driver.resumableSession()).toBe(h.fake.session)
  })

  it('any other load failure ends the driver with error:load and its reason, before any prompt', async () => {
    const h = start({ app: true, script: ended, loadSessionId: 'acp-1', refuseLoad: { code: -32603, message: 'Internal error\u001b[2J' } })
    expect(await h.done).toBe('error:load')
    expect(h.driver.loadFailure()).toBe('Internal error\\x1b[2J')
    expect(h.fake.prompts()).toEqual([])
    expect(h.fake.received.some((m) => m.method === 'session/new')).toBe(false)
  })

  it('reports the native host, linked sessions and usage to the launch row', async () => {
    const h = start({ app: true, script: ended })
    await h.ready()
    await until(() => h.log.find((e) => e.event === 'turn_end'), 'the first turn')
    await until(() => getLaunch(h.human, LAUNCH)!.host_pid === HOST, 'the host recorded')
    expect(getLaunch(h.human, LAUNCH)).toMatchObject({ sessions: ['mcp-1'], status: 'running' })
    expect(getLaunch(h.human, LAUNCH)!.revision).toBeGreaterThan(1)
    h.driver.stop()
    await h.done
  })

  it('a session is resumable once its task was sent, and not before (a never-prompted session cannot be loaded)', async () => {
    const h = start({ app: true, script: ended, linked: [], timing: { linkWaitMs: 10_000, idleMs: 60 } })
    await until(() => h.log.find((e) => e.event === 'ready'), 'ready')
    expect(h.driver.resumableSession()).toBeNull()
    h.driver.stop()
    await h.done
    const later = start({ app: false, script: ended, timing: { idleMs: 60 } })
    expect(await later.done).toBe('idle')
    expect(later.driver.resumableSession()).toBe(later.fake.session)
  })

  it('resumes by loading the session: no task re-sent, the earlier sessions’ open messages move to the new server and are pushed again', async () => {
    const id = '00000000-0000-4000-8000-000000000009'
    const h = start({
      app: true, script: ended, loadSessionId: '57b24380-5e36-4758-89a3-69f04ce06a40', linked: [],
      priorSessions: [{ session: 'mcp-old', dead: true }],
    })
    // the parked launch's earlier session, ended with an open message
    presence(h.human, 'mcp-old', { server_pid: 76000 })
    sendSessionMessage(h.human, { id, session: 'mcp-old', text: 'Also run lint.' })
    endActivity(h.human, 'mcp-old')
    await until(() => h.log.find((e) => e.event === 'ready'), 'ready')
    expect(h.fake.received.some((m) => m.method === 'session/load')).toBe(true)
    // the resumed driver's new server links
    h.scan.result = { hostPid: HOST, linked: ['mcp-1'], dead: [] }
    await until(() => h.log.find((e) => e.event === 'readdress' && (e.result as Json).ok), 'readdress')
    expect(listSessionMessages(h.human).open.map((m) => [m.id, m.session])).toEqual([[id, 'mcp-1']])
    await until(() => h.fake.prompts().length === 1, 'the push')
    expect(h.fake.prompts()[0]).toContain('[00000000-0000-4000-8000-000000000009] Also run lint.')
    expect(h.fake.prompts().some((p) => p.includes('Fix the failing test.'))).toBe(false)
    h.driver.stop()
    await h.done
  })
})
