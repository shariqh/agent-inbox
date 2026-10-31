// Issue #412 — the driver's one serialized state machine for a Copilot session
// over ACP. Design: docs/superpowers/specs/2026-10-31-driven-sessions-design.md
// §3.1, §4.1–4.3, §5.1–5.3 and §7; spike amendments §14.4.
//
// Every ACP frame read from the child and every human intent (a TTY answer, an
// interrupt, a stop) goes through ONE queue and is handled one at a time in
// arrival order. An intent therefore always lands behind every frame already
// read, so an approval is never applied to a security state the human did not
// see: before answering a permission request the driver re-validates the
// security-state generation the ask recorded (§4.1, Ordering).
//
// It reads and writes the hub only through store.ts, holds the leases that make
// its sessions `driven`, pushes each human message once per launch and pings
// the session when the human answers one of its asks. It never binds a listener
// and never enters the stdio MCP server's or the viewer's import graph.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type Database from 'better-sqlite3'
import { ACP_PROTOCOL_VERSION, connectAcp } from './acp-client.js'
import type { AcpConnection, AcpFrame, JsonRpcId } from './acp-client.js'
import {
  MODE_AGENT, MODE_PLAN, PLAN_APPROVED_PROMPT, answerPingPrompt, askTitle, cappedInput, filterOptions, firstPrompt,
  initialPhase, interruptPrompt, messagesPrompt, phaseMode, promptSafe, stateValid,
} from './driver-policy.js'
import type { LaunchMode, Phase, PushedMessage } from './driver-policy.js'
import {
  driverStopRequested, holdDriverLeases, hubDataVersion, insertItem, listAnsweredSessionAsks, listOpenMessagesWithText,
  markMessageDelivered, readdressMessages, releaseDriverLeases, resolveItem,
} from './store.js'
import type { DriverLease } from './store.js'

export type EndReason =
  | 'stopped' | 'idle' | 'child_exit'
  | 'budget:active_time' | 'budget:tool_calls'
  | 'error:mode_escalation' | 'error:setup' | 'error:hub_unreachable' | 'error:lease_lost' | 'error:protocol'

export interface AskView {
  id: string
  kind: 'permission' | 'plan'
  title: string
  /** The tool kind and its input, capped at 4 KB, for the terminal. */
  detail: string
}

export interface DriverUi {
  ask(ask: AskView): void
  settled(askId: string, outcome: string): void
  text(chunk: string): void
  notice(line: string): void
}

export interface DriverTiming {
  pollMs: number
  scanMs: number
  leaseMs: number
  hubFailMs: number
  stopGraceMs: number
  setupWaitMs: number
  /** How long the first prompt waits for the session's MCP server to link. */
  linkWaitMs: number
  idleMs: number
  activeMs: number
  maxToolCalls: number
}

const DEFAULT_TIMING: DriverTiming = {
  pollMs: 1000,
  scanMs: 2000,
  leaseMs: 30_000,
  hubFailMs: 30_000,
  stopGraceMs: 10_000,
  setupWaitMs: 10_000,
  linkWaitMs: 10_000,
  idleMs: 2 * 60 * 60_000,
  activeMs: 2 * 60 * 60_000,
  maxToolCalls: 500,
}

/** What an ancestry scan reports (driver-link.ts). `hostPid` is null until the native host is found. */
export interface ScanResult {
  hostPid: number | null
  linked: string[]
  dead: string[]
}

export interface DriverOptions {
  db: Database.Database
  lease: DriverLease
  mode: LaunchMode
  cwd: string
  /** The real project and branch, shown in each @sessions alert's stream. */
  project: string
  stream: string
  task: string
  /** The child's stdout and stdin. */
  input: Readable
  output: Writable
  child: { kill(signal: NodeJS.Signals): void; exited: Promise<unknown> }
  ui: DriverUi
  log: (event: Record<string, unknown>) => void
  /** `<hub dir>/drivers/<launch id>`, where pushed.json lives. */
  stateDir: string
  scan: () => Promise<ScanResult>
  timing?: Partial<DriverTiming>
  /** Step 3's resume: load this ACP session instead of creating one. */
  loadSessionId?: string
}

interface SecurityState {
  mode: string
  allowAll: string
  generation: number
}

interface PendingAsk {
  id: string
  kind: 'permission' | 'plan'
  itemId: string
  rpcId?: JsonRpcId
  allow?: string
  reject?: string | null
  generation: number
}

type Turn = { rpcId: number; startedAt: number; kind: 'task' | 'messages' | 'ping' | 'control' | 'interrupt' }

type Event =
  | { type: 'frame'; frame: AcpFrame }
  | { type: 'answer'; askId: string; approve: boolean }
  | { type: 'interrupt' }
  | { type: 'stop'; reason: EndReason }
  | { type: 'tick' }
  | { type: 'scan'; result: ScanResult }
  | { type: 'child_exit' }
  | { type: 'setup_timeout'; step: number }

interface PushedFile {
  v: 1
  sessions: Record<string, string[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configValue(options: unknown, id: string): string | undefined {
  if (!Array.isArray(options)) return undefined
  const option = options.find((o) => isRecord(o) && o.id === id) as Record<string, unknown> | undefined
  return typeof option?.currentValue === 'string' ? option.currentValue : undefined
}

export class Driver {
  private readonly o: DriverOptions
  private readonly t: DriverTiming
  private readonly conn: AcpConnection
  private readonly queue: Event[] = []
  private draining = false
  private scheduled = false
  private sessionId: string | null = null
  private loading = false
  private state: SecurityState = { mode: '', allowAll: '', generation: 0 }
  private phase: Phase
  // setup: 0 initialize, 1 new/load, 2 set_mode, 4 allow_all re-asserted off, 5 ready
  private setup = 0
  private setupRpc: number | null = null
  private switchRpc: number | null = null
  private switchSeen = false
  private turn: Turn | null = null
  private interrupting = false
  private pendingControl: string[] = []
  private taskSent = false
  private readyAt = 0
  private readonly asks = new Map<string, PendingAsk>()
  private askSeq = 0
  private readonly toolTitles = new Map<string, { title: string; rawInput: unknown; kind: string }>()
  private toolCalls = 0
  private activeMs = 0
  private lastActivity = Date.now()
  private lastHubOk = Date.now()
  private dataVersion: number | null = null
  private hostPid: number | null = null
  private readonly linked: string[] = []
  private readonly ended = new Map<string, boolean>()
  private held: string[] = []
  private pushed: PushedFile
  private readonly pinged = new Set<string>()
  private ending: EndReason | null = null
  private finished = false
  private childGone = false
  private readonly timers: NodeJS.Timeout[] = []
  private resolveEnd!: (reason: EndReason) => void
  readonly done: Promise<EndReason>

  constructor(options: DriverOptions) {
    this.o = options
    this.t = { ...DEFAULT_TIMING, ...options.timing }
    this.phase = initialPhase(options.mode)
    this.pushed = this.readPushed()
    this.done = new Promise((resolve) => { this.resolveEnd = resolve })
    this.conn = connectAcp({
      input: options.input,
      output: options.output,
      onFrame: (frame) => this.enqueue({ type: 'frame', frame }),
    })
    options.child.exited.then(() => this.enqueue({ type: 'child_exit' }), () => this.enqueue({ type: 'child_exit' }))
  }

  // ── public intents: each one queues behind every frame already read ──────

  start(): Promise<EndReason> {
    this.setupRpc = this.conn.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-inbox-driver', version: '1' },
    })
    this.timers.push(setInterval(() => this.enqueue({ type: 'tick' }), this.t.pollMs))
    this.timers.push(setInterval(() => this.runScan(), this.t.scanMs))
    this.timers.push(setInterval(() => this.refreshLeases(), this.t.leaseMs))
    for (const timer of this.timers) timer.unref()
    return this.done
  }

  answer(askId: string, approve: boolean): void {
    this.enqueue({ type: 'answer', askId, approve })
  }

  interrupt(): void {
    this.enqueue({ type: 'interrupt' })
  }

  stop(): void {
    this.enqueue({ type: 'stop', reason: 'stopped' })
  }

  // ── the queue ─────────────────────────────────────────────────────────────

  private enqueue(event: Event): void {
    if (this.finished) return
    this.queue.push(event)
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      this.drain()
    })
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    try {
      for (let event = this.queue.shift(); event; event = this.queue.shift()) {
        if (this.finished) break
        try {
          this.handle(event)
        } catch (error) {
          this.o.log({ event: 'driver_error', message: error instanceof Error ? error.message : String(error) })
          this.end('error:protocol')
        }
      }
    } finally {
      this.draining = false
    }
  }

  private handle(event: Event): void {
    switch (event.type) {
      case 'frame': return this.onFrame(event.frame)
      case 'answer': return this.onAnswer(event.askId, event.approve)
      case 'interrupt': return this.onInterrupt()
      case 'stop': return this.end(event.reason)
      case 'tick': return this.onTick()
      case 'scan': return this.onScan(event.result)
      case 'child_exit':
        this.childGone = true
        if (!this.ending) this.end('child_exit')
        else this.finish()
        return
      case 'setup_timeout':
        if (this.setup === event.step) {
          this.o.log({ event: 'setup_failed', reason: 'allow_all was not verified off' })
          this.end('error:mode_escalation')
        }
    }
  }

  // ── frames ────────────────────────────────────────────────────────────────

  private onFrame(frame: AcpFrame): void {
    if (frame.kind === 'invalid') {
      this.o.log({ event: 'invalid_frame', reason: frame.reason })
      return
    }
    if (frame.kind === 'response') return this.onResponse(frame)
    if (frame.kind === 'request') return this.onRequest(frame)
    if (frame.method === 'session/update') this.onUpdate(frame.params)
  }

  private onResponse(frame: Extract<AcpFrame, { kind: 'response' }>): void {
    this.o.log({ event: 'response', id: frame.id, method: frame.method, ...(frame.error ? { error: frame.error } : {}) })
    if (frame.id === this.setupRpc) return this.onSetupResponse(frame)
    if (frame.id === this.switchRpc) return this.onSwitchResponse(frame)
    if (this.turn && frame.id === this.turn.rpcId) return this.onTurnEnd(frame)
  }

  private onSetupResponse(frame: Extract<AcpFrame, { kind: 'response' }>): void {
    this.setupRpc = null
    if (frame.error) {
      this.o.ui.notice(`Copilot refused ${frame.method}: ${frame.error.message}`)
      return this.end('error:setup')
    }
    const result = isRecord(frame.result) ? frame.result : {}
    if (frame.method === 'initialize') {
      this.setup = 1
      const params = { cwd: this.o.cwd, mcpServers: [] }
      if (this.o.loadSessionId) {
        this.sessionId = this.o.loadSessionId
        this.loading = true
        this.setupRpc = this.conn.request('session/load', { sessionId: this.o.loadSessionId, ...params })
      } else {
        this.setupRpc = this.conn.request('session/new', params)
      }
      return
    }
    if (frame.method === 'session/new' || frame.method === 'session/load') {
      this.loading = false
      if (frame.method === 'session/new') {
        if (typeof result.sessionId !== 'string') return this.end('error:setup')
        this.sessionId = result.sessionId
      }
      // a load replays history before it answers; that history was ignored, and
      // the state is what the response says now (§7)
      const modes = isRecord(result.modes) ? result.modes : {}
      this.state = {
        mode: typeof modes.currentModeId === 'string' ? modes.currentModeId : configValue(result.configOptions, 'mode') ?? '',
        allowAll: configValue(result.configOptions, 'allow_all') ?? '',
        generation: this.state.generation + 1,
      }
      this.o.log({ event: 'session', sessionId: this.sessionId, mode: this.state.mode, allow_all: this.state.allowAll })
      this.setup = 2
      this.setupRpc = this.conn.request('session/set_mode', { sessionId: this.sessionId, modeId: phaseMode(this.phase) })
      return
    }
    if (frame.method === 'session/set_mode') {
      this.state.generation++
      if (this.state.mode !== phaseMode(this.phase)) {
        this.o.log({ event: 'setup_failed', reason: 'mode not set', mode: this.state.mode })
        return this.end('error:mode_escalation')
      }
      if (this.state.allowAll === 'off') return this.ready()
      // allow_all is still on (a loaded session left in autopilot, §4.1 rule 2):
      // re-assert it off once, and continue only when a config_option_update
      // verifies off
      this.setup = 4
      this.setupRpc = this.conn.request('session/set_config_option', { sessionId: this.sessionId, configId: 'allow_all', value: 'off' })
      const timer = setTimeout(() => this.enqueue({ type: 'setup_timeout', step: 4 }), this.t.setupWaitMs)
      timer.unref()
      this.timers.push(timer)
      return
    }
    if (frame.method === 'session/set_config_option') this.state.generation++
  }

  private ready(): void {
    if (this.setup === 5) return
    this.setup = 5
    this.readyAt = Date.now()
    this.o.log({ event: 'ready', phase: this.phase, mode: this.state.mode, allow_all: this.state.allowAll, generation: this.state.generation })
    this.o.ui.notice(`Session ready (${this.phase === 'executing' ? 'agent mode' : 'plan mode'}).`)
    this.maybePrompt()
  }

  private onUpdate(params: Record<string, unknown>): void {
    if (params.sessionId !== this.sessionId || !isRecord(params.update)) return
    if (this.loading) return
    const update = params.update
    const kind = update.sessionUpdate
    this.lastActivity = Date.now()
    if (kind === 'current_mode_update') {
      const mode = typeof update.currentModeId === 'string' ? update.currentModeId : ''
      this.o.log({ event: 'mode_update', mode, turn: this.turn?.rpcId ?? null })
      const switched = this.phase === 'switching' && mode === MODE_AGENT && this.state.mode !== MODE_AGENT
      this.state = { ...this.state, mode, generation: this.state.generation + 1 }
      if (switched) {
        if (this.switchSeen) return this.escalate('a second switch')
        this.switchSeen = true
      }
      return this.checkState()
    }
    if (kind === 'config_option_update') {
      const mode = configValue(update.configOptions, 'mode')
      const allowAll = configValue(update.configOptions, 'allow_all')
      this.o.log({ event: 'config_update', mode: mode ?? null, allow_all: allowAll ?? null, turn: this.turn?.rpcId ?? null })
      this.state = {
        mode: mode ? mode : this.state.mode,
        allowAll: allowAll ?? this.state.allowAll,
        generation: this.state.generation + 1,
      }
      if (this.setup === 4) {
        if (this.state.allowAll === 'off' && this.state.mode === phaseMode(this.phase)) return this.ready()
        return this.escalate('allow_all stayed on after the driver turned it off')
      }
      return this.checkState()
    }
    if (kind === 'tool_call') {
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : ''
      const title = typeof update.title === 'string' ? update.title : ''
      this.toolTitles.set(id, { title, rawInput: update.rawInput, kind: typeof update.kind === 'string' ? update.kind : '' })
      this.toolCalls++
      this.o.log({ event: 'tool_call', id, title, kind: update.kind, input: cappedInput(update.rawInput), turn: this.turn?.rpcId ?? null })
      if (this.toolCalls >= this.t.maxToolCalls && this.setup === 5) this.end('budget:tool_calls')
      return
    }
    if (kind === 'agent_message_chunk') {
      const content = isRecord(update.content) ? update.content : {}
      if (typeof content.text === 'string') this.o.ui.text(content.text)
      this.o.log({ event: 'agent_text', text: content.text ?? '', turn: this.turn?.rpcId ?? null })
      return
    }
    this.o.log({ event: 'update', kind, turn: this.turn?.rpcId ?? null })
  }

  // The escalation guard (§4.1 rule 3): once ready, any state outside the
  // phase's valid set ends the launch.
  private checkState(): void {
    if (this.setup !== 5) return
    if (!stateValid(this.phase, this.state)) this.escalate(`${this.state.mode} with allow_all ${this.state.allowAll}`)
  }

  private escalate(why: string): void {
    this.o.log({ event: 'mode_escalation', why, phase: this.phase, mode: this.state.mode, allow_all: this.state.allowAll })
    this.o.ui.notice(`Ending the session: its permissions changed outside what you allowed (${why}).`)
    this.end('error:mode_escalation')
  }

  // ── permission requests and approvals ───────────────────────────────────

  private onRequest(frame: Extract<AcpFrame, { kind: 'request' }>): void {
    if (frame.method !== 'session/request_permission' || frame.params.sessionId !== this.sessionId || this.ending) {
      if (frame.method === 'session/request_permission') this.conn.respond(frame.id, { outcome: { outcome: 'cancelled' } })
      return
    }
    const toolCall = isRecord(frame.params.toolCall) ? frame.params.toolCall : {}
    const toolCallId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : ''
    const seen = this.toolTitles.get(toolCallId)
    const toolTitle = seen?.title || (typeof toolCall.title === 'string' ? toolCall.title : 'a tool')
    const rawInput = seen?.rawInput ?? toolCall.rawInput
    const kind = typeof toolCall.kind === 'string' ? toolCall.kind : seen?.kind ?? ''
    const options = filterOptions(Array.isArray(frame.params.options) ? frame.params.options : [])
    this.o.log({ event: 'permission_request', id: frame.id, tool: toolTitle, kind, allow: options.allow, reject: options.reject, dropped: options.dropped, turn: this.turn?.rpcId ?? null })
    if (options.allow === null) {
      this.conn.respond(frame.id, options.reject ? { outcome: { outcome: 'selected', optionId: options.reject } } : { outcome: { outcome: 'cancelled' } })
      this.o.log({ event: 'permission_answer', id: frame.id, answer: options.reject ?? 'cancelled', why: 'no allowed option' })
      return
    }
    const input = cappedInput(rawInput)
    const title = askTitle(toolTitle, rawInput)
    const id = `ask-${++this.askSeq}`
    const itemId = this.fileAlert(title, [
      `Tool kind: ${kind || 'unknown'}`,
      `Folder: ${this.o.cwd}`,
      `Launch: ${this.o.lease.launchId}`,
      'Declining stops the agent’s current turn.',
      '',
      'Input:',
      input,
    ].join('\n'))
    this.asks.set(id, { id, kind: 'permission', itemId, rpcId: frame.id, allow: options.allow, reject: options.reject, generation: this.state.generation })
    this.o.ui.ask({ id, kind: 'permission', title, detail: `${kind ? `${kind}: ` : ''}${input}` })
  }

  private fileAlert(title: string, context: string): string {
    return insertItem(this.o.db, {
      project: '@sessions',
      stream: [this.o.project, this.o.stream].filter(Boolean).join(' · '),
      agent: 'copilot',
      session: this.linked.find((s) => !this.ended.has(s)),
      kind: 'question',
      title,
      detail: 'A session Agent Inbox drives is waiting for your approval in its terminal.',
      next_step: 'Answer in the terminal running the driver.',
      action_owner: 'task',
      impact: 'The agent waits until you answer.',
      context,
    })
  }

  private settle(ask: PendingAsk, outcome: string): void {
    this.asks.delete(ask.id)
    try {
      resolveItem(this.o.db, ask.itemId, outcome)
    } catch (error) {
      this.o.log({ event: 'hub_write_failed', what: 'resolve ask', message: error instanceof Error ? error.message : String(error) })
    }
    this.o.ui.settled(ask.id, outcome)
  }

  private onAnswer(askId: string, approve: boolean): void {
    const ask = this.asks.get(askId)
    if (!ask || this.ending) return
    if (ask.kind === 'plan') return this.onPlanAnswer(ask, approve)
    const rpcId = ask.rpcId!
    if (!approve) {
      this.conn.respond(rpcId, ask.reject ? { outcome: { outcome: 'selected', optionId: ask.reject } } : { outcome: { outcome: 'cancelled' } })
      this.o.log({ event: 'permission_answer', id: rpcId, answer: ask.reject ?? 'cancelled' })
      return this.settle(ask, 'Declined in the terminal; the agent’s turn stopped.')
    }
    // re-validate against the state the human saw (§4.1, Ordering)
    if (ask.generation !== this.state.generation) {
      this.conn.respond(rpcId, ask.reject ? { outcome: { outcome: 'selected', optionId: ask.reject } } : { outcome: { outcome: 'cancelled' } })
      this.o.log({ event: 'permission_answer', id: rpcId, answer: ask.reject ?? 'cancelled', why: 'generation moved', asked: ask.generation, now: this.state.generation })
      return this.settle(ask, 'Not applied: the session’s permissions changed while you were answering.')
    }
    if (!stateValid(this.phase, this.state)) return this.escalate('invalid state at approval')
    this.conn.respond(rpcId, { outcome: { outcome: 'selected', optionId: ask.allow! } })
    this.o.log({ event: 'permission_answer', id: rpcId, answer: ask.allow })
    this.settle(ask, 'Allowed once in the terminal.')
  }

  // ── Plan first (§4.1 phases) ─────────────────────────────────────────────

  private askPlanApproval(): void {
    if ([...this.asks.values()].some((ask) => ask.kind === 'plan')) return
    const id = `ask-${++this.askSeq}`
    const title = 'Approve the plan and continue?'
    const itemId = this.fileAlert(title, [
      `Folder: ${this.o.cwd}`,
      `Launch: ${this.o.lease.launchId}`,
      'Approving switches the session from plan mode to agent mode; tool calls still ask for approval.',
    ].join('\n'))
    this.asks.set(id, { id, kind: 'plan', itemId, generation: this.state.generation })
    this.o.ui.ask({ id, kind: 'plan', title, detail: 'The agent wrote its plan. Approve it to let the agent carry it out.' })
  }

  private onPlanAnswer(ask: PendingAsk, approve: boolean): void {
    if (!approve) return this.settle(ask, 'Declined in the terminal; the session stays in plan mode.')
    if (this.phase !== 'awaiting_plan_approval' || !stateValid(this.phase, this.state)) return this.escalate('invalid state at plan approval')
    this.settle(ask, 'Approved in the terminal.')
    this.phase = 'switching'
    this.switchSeen = false
    this.switchRpc = this.conn.request('session/set_mode', { sessionId: this.sessionId, modeId: MODE_AGENT })
    this.o.log({ event: 'plan_approved', switch: this.switchRpc })
  }

  private onSwitchResponse(frame: Extract<AcpFrame, { kind: 'response' }>): void {
    this.switchRpc = null
    this.state.generation++
    if (frame.error || this.state.mode !== MODE_AGENT || this.state.allowAll !== 'off') {
      return this.escalate('the switch to agent mode did not verify')
    }
    this.phase = 'executing'
    this.pendingControl.push(PLAN_APPROVED_PROMPT)
    this.maybePrompt()
  }

  // ── turns and pushes (§3.1, §5.3) ────────────────────────────────────────

  private sendPrompt(text: string, kind: Turn['kind']): boolean {
    if (!promptSafe(text)) {
      this.o.log({ event: 'prompt_refused', why: 'starts with /' })
      this.o.ui.notice('Refused to send a prompt that starts with "/".')
      return false
    }
    const rpcId = this.conn.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] })
    this.turn = { rpcId, startedAt: Date.now(), kind }
    this.lastActivity = Date.now()
    this.o.log({ event: 'prompt', id: rpcId, kind, chars: text.length })
    return true
  }

  private maybePrompt(): void {
    if (this.setup !== 5 || this.turn || this.ending || this.switchRpc !== null || !this.sessionId) return
    const control = this.pendingControl.shift()
    if (control !== undefined) {
      this.sendPrompt(control, 'control')
      return
    }
    if (!this.taskSent) {
      // the session's agent-inbox server starts during session/new; wait for it
      // to link so its alerts carry its session and its messages can be pushed
      if (!this.live().length && Date.now() - this.readyAt < this.t.linkWaitMs) return
      this.taskSent = true
      this.sendPrompt(firstPrompt(this.o.task), 'task')
      return
    }
    const messages = this.unpushedMessages()
    if (messages.length) {
      this.pushMessages(messages, (list) => messagesPrompt(list), 'messages')
      return
    }
    this.pingAnswers()
  }

  private live(): string[] {
    return this.linked.filter((s) => !this.ended.has(s))
  }

  // The re-check: read just before prompting, so a message acked or withdrawn
  // since the last poll is never pushed (§5.3 step 1).
  private unpushedMessages(): Array<PushedMessage & { session: string }> {
    const live = this.live()
    if (!live.length) return []
    return listOpenMessagesWithText(this.o.db, live)
      .filter((m) => !(this.pushed.sessions[m.session] ?? []).includes(m.id))
      .map((m) => ({ id: m.id, text: m.text, session: m.session }))
  }

  private pushMessages(
    messages: Array<PushedMessage & { session: string }>,
    frame: (list: PushedMessage[]) => string,
    kind: Turn['kind'],
  ): void {
    // recorded before the prompt is sent: a message is pushed once per launch (§5.3 step 3)
    for (const m of messages) (this.pushed.sessions[m.session] ??= []).push(m.id)
    this.writePushed()
    for (const m of messages) markMessageDelivered(this.o.db, m.id, m.session, 'agent-inbox-driver')
    this.sendPrompt(frame(messages), kind)
    this.o.log({ event: 'pushed', ids: messages.map((m) => m.id) })
  }

  private pingAnswers(): void {
    const answers = listAnsweredSessionAsks(this.o.db, this.live()).filter((a) => !this.pinged.has(a.key))
    if (!answers.length) return
    for (const answer of answers) this.pinged.add(answer.key)
    this.sendPrompt(answers.map((a) => answerPingPrompt(a.title)).join('\n'), 'ping')
  }

  private onTurnEnd(frame: Extract<AcpFrame, { kind: 'response' }>): void {
    const turn = this.turn!
    this.turn = null
    this.activeMs += Date.now() - turn.startedAt
    this.lastActivity = Date.now()
    const result = isRecord(frame.result) ? frame.result : {}
    const stopReason = typeof result.stopReason === 'string' ? result.stopReason : frame.error ? 'error' : 'unknown'
    this.o.log({ event: 'turn_end', id: turn.rpcId, kind: turn.kind, stopReason, usage: result.usage ?? null })
    this.o.ui.notice(`Turn ended (${stopReason}).`)
    if (this.ending) return this.finish()
    if (this.activeMs >= this.t.activeMs) return this.end('budget:active_time')
    if (this.interrupting) {
      this.interrupting = false
      for (const ask of [...this.asks.values()]) {
        if (ask.kind !== 'permission') continue
        this.conn.respond(ask.rpcId!, { outcome: { outcome: 'cancelled' } })
        this.settle(ask, 'Interrupted.')
      }
      const messages = this.unpushedMessages()
      if (messages.length) return this.pushMessages(messages, (list) => interruptPrompt(list), 'interrupt')
    }
    if (this.phase === 'awaiting_plan_approval' && stopReason === 'end_turn' && this.state.mode === MODE_PLAN) this.askPlanApproval()
    this.maybePrompt()
  }

  // Interrupt and send (§5.3): cancel, wait for the turn's own `cancelled`
  // answer, answer open requests cancelled, then send — in onTurnEnd.
  private onInterrupt(): void {
    if (!this.turn || this.interrupting || this.ending) return
    if (!this.unpushedMessages().length) {
      this.o.ui.notice('Nothing to send: no message is waiting.')
      return
    }
    this.interrupting = true
    this.conn.notify('session/cancel', { sessionId: this.sessionId })
    this.o.log({ event: 'interrupt', turn: this.turn.rpcId })
  }

  // ── the hub: polling, linking, leases, fail-closed ───────────────────────

  private onTick(): void {
    let version: number
    try {
      version = hubDataVersion(this.o.db)
      if (driverStopRequested(this.o.db, this.o.lease.launchId)) return this.end('stopped')
      this.lastHubOk = Date.now()
    } catch (error) {
      this.o.log({ event: 'hub_read_failed', message: error instanceof Error ? error.message : String(error) })
      if (Date.now() - this.lastHubOk >= this.t.hubFailMs) this.end('error:hub_unreachable')
      return
    }
    if (this.turn && this.activeMs + (Date.now() - this.turn.startedAt) >= this.t.activeMs) return this.end('budget:active_time')
    if (!this.turn && this.asks.size === 0 && Date.now() - this.lastActivity >= this.t.idleMs) return this.end('idle')
    if (version !== this.dataVersion || !this.taskSent) {
      this.dataVersion = version
      this.maybePrompt()
    }
  }

  private runScan(): void {
    this.o.scan().then(
      (result) => this.enqueue({ type: 'scan', result }),
      (error: unknown) => this.o.log({ event: 'scan_failed', message: error instanceof Error ? error.message : String(error) }),
    )
  }

  private onScan(result: ScanResult): void {
    if (result.hostPid === null) return
    if (this.hostPid === null) {
      this.hostPid = result.hostPid
      this.o.log({ event: 'native_host', pid: result.hostPid })
    }
    let changed = false
    for (const session of result.linked) {
      if (!this.linked.includes(session)) {
        this.linked.push(session)
        changed = true
        this.o.log({ event: 'linked', session })
      }
    }
    const current = new Set(result.linked)
    for (const session of this.linked) {
      if (current.has(session) || this.ended.has(session)) continue
      this.ended.set(session, result.dead.includes(session))
      changed = true
      this.o.log({ event: 'session_ended', session })
    }
    if (changed) this.refreshLeases()
    this.readdressEnded()
    if (changed) this.maybePrompt()
  }

  // Proof by launch (§5.2): an ended session's open messages move to the
  // launch's own live server, and its pushed ids move with them.
  private readdressEnded(): void {
    const to = this.live().at(-1)
    if (!to || this.hostPid === null) return
    for (const [from, dead] of [...this.ended]) {
      if (!this.held.includes(from)) continue
      const result = readdressMessages(this.o.db, { from, to, launchId: this.o.lease.launchId, hostPid: this.hostPid, fromServerDead: dead })
      this.o.log({ event: 'readdress', from, to, result })
      if (!result.ok) continue
      const moved = (this.pushed.sessions[from] ?? []).filter((id) => result.moved.includes(id))
      if (moved.length) {
        this.pushed.sessions[to] = [...(this.pushed.sessions[to] ?? []), ...moved]
        this.writePushed()
      }
      this.held = this.held.filter((s) => s !== from)
      this.refreshLeases()
    }
  }

  private refreshLeases(): void {
    if (this.finished) return
    const want = [...this.live(), ...[...this.ended.keys()].filter((s) => this.held.includes(s))]
    try {
      const out = holdDriverLeases(this.o.db, this.o.lease, want)
      this.held = out.held
      if (!out.driver) this.enqueue({ type: 'stop', reason: 'error:lease_lost' })
    } catch (error) {
      this.o.log({ event: 'hub_write_failed', what: 'leases', message: error instanceof Error ? error.message : String(error) })
    }
  }

  // ── pushed.json (§5.3) ───────────────────────────────────────────────────

  private readPushed(): PushedFile {
    const file = join(this.o.stateDir, 'pushed.json')
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as PushedFile
        if (parsed?.v === 1 && isRecord(parsed.sessions)) return parsed
      }
    } catch { /* unreadable: start empty; the database stays the truth */ }
    return { v: 1, sessions: {} }
  }

  private writePushed(): void {
    const file = join(this.o.stateDir, 'pushed.json')
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(this.pushed), { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, file)
  }

  // ── the end (§7) ─────────────────────────────────────────────────────────

  private end(reason: EndReason): void {
    if (this.ending) return
    this.ending = reason
    this.o.log({ event: 'ending', reason })
    const outcome = reason === 'stopped' ? 'Session stopped.' : `Session ended (${reason}).`
    for (const ask of [...this.asks.values()]) {
      if (ask.rpcId !== undefined) this.conn.respond(ask.rpcId, { outcome: { outcome: 'cancelled' } })
      this.settle(ask, outcome)
    }
    if (this.sessionId && this.turn) this.conn.notify('session/cancel', { sessionId: this.sessionId })
    if (!this.turn || this.childGone) return this.finish()
    // wait for the cancelled turn to answer, at most the grace
    const timer = setTimeout(() => this.finish(), this.t.stopGraceMs)
    timer.unref()
    this.timers.push(timer)
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    for (const timer of this.timers) clearTimeout(timer)
    this.conn.close()
    if (!this.childGone) {
      const kill = setTimeout(() => this.o.child.kill('SIGTERM'), this.t.stopGraceMs)
      kill.unref()
      this.o.child.exited.finally(() => clearTimeout(kill)).catch(() => undefined)
    }
    try {
      releaseDriverLeases(this.o.db, this.o.lease)
    } catch { /* the hub is gone: the leases go stale in 90 s */ }
    this.o.log({ event: 'ended', reason: this.ending })
    this.resolveEnd(this.ending ?? 'stopped')
  }
}
