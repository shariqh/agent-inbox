// The Claude Code hooks runtime (issues #10 and #21).
//
// This is a SECOND OS process writing to ~/.agent-inbox/inbox.db, and it still
// goes through src/store.ts — there is no SQL string and no `sqlite3` CLI call
// anywhere in this file. Everything is fail-open: a hook that throws prints in
// the human's terminal and a hook that hangs stalls their prompt, so every
// entry point is wrapped, diagnostics go to a log file (never stdout/stderr),
// and the CLI exits 0 unless a subcommand deliberately asks otherwise.
//
// The stdout contract is per-subcommand and exact — see docs/hooks.md.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, unlinkSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { defaultDbPath, insertItem, listItems, listPending, openDb, resolveItem } from './store.js'
import type { Item } from './store.js'
import { inferProject, inferStream } from './infer.js'

// Every subcommand the dispatcher answers to. docs/hooks.md is checked against
// this list by test/hook.test.ts so the reference cannot drift from the code.
export const SUBCOMMANDS = [
  'notification',
  'notification-commit',
  'session-start',
  'session-end',
  'prompt-submit',
  'stop',
  'watch',
  'sweep',
  'selftest',
] as const

export type Subcommand = (typeof SUBCOMMANDS)[number]

export interface HookResult {
  stdout: string
  stderr?: string
  exitCode?: number
}

// The subset of the Claude Code hook payload this runtime reads. Everything is
// optional: stdin is arbitrary attacker-adjacent JSON, so nothing is asserted.
export interface HookEvent {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  notification_type?: string
  message?: string
  reason?: string
  source?: string
  stop_hook_active?: boolean
}

// Per-session state, kept next to the db (not in homedir) so AGENT_INBOX_DB
// makes the whole runtime hermetic under test.
export interface SessionMarker {
  insertCount: number
  lastInsertAt: number
  // set when a permission prompt is first seen; the item is only written if the
  // prompt is STILL unanswered after the grace window (see cmdNotificationCommit)
  pendingPromptAt?: number | null
  transcript?: { mtimeMs: number; size: number } | null
}

export interface HookOpts {
  recentMs: number
  cooldownMs: number
  maxPerSession: number
  maxAgeMs: number
  graceMs: number
  notifyTypes: string[]
  watchSecs: number
  watchPollMs: number
}

export type Env = Record<string, string | undefined>

const MAX_BACKOFF_MS = 4 * 60 * 60 * 1000
const LOG_MAX_BYTES = 1024 * 1024
// older CLIs send no notification_type; this is the fallback gate on `message`
const PROMPT_MESSAGE_RE = /permission|approve this|waiting for your input/i

function num(raw: string | undefined, fallback: number, min = 0): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= min ? n : fallback
}

export function hookOpts(env: Env): HookOpts {
  const types = (env.AGENT_INBOX_HOOK_NOTIFY_TYPES ?? 'permission_prompt')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    recentMs: num(env.AGENT_INBOX_HOOK_RECENT_MS, 30 * 60_000),
    cooldownMs: num(env.AGENT_INBOX_HOOK_COOLDOWN_MS, 10 * 60_000),
    // a cap of 0 would mean "never", which is what AGENT_INBOX_HOOKS=0 is for
    maxPerSession: num(env.AGENT_INBOX_HOOK_MAX_PER_SESSION, 3, 1),
    maxAgeMs: num(env.AGENT_INBOX_HOOK_MAX_AGE_MS, 24 * 60 * 60 * 1000),
    // an ordinary permission prompt the human answers promptly must NOT earn an
    // inbox row (and, in the packaged app, an un-withdrawable desktop notification)
    graceMs: num(env.AGENT_INBOX_HOOK_GRACE_MS, 90_000),
    notifyTypes: types.length ? types : ['permission_prompt'],
    watchSecs: num(env.AGENT_INBOX_WATCH_SECS, 1740),
    watchPollMs: num(env.AGENT_INBOX_WATCH_POLL_MS, 2000, 1),
  }
}

// ── the settings.json registration block ────────────────────────────────────

interface HookEntry {
  type: 'command'
  command: string
  args: string[]
  timeout: number
  statusMessage?: string
  asyncRewake?: boolean
  rewakeSummary?: string
}

// One source of truth for what "installed" means, shared by the viewer's Setup
// panel and pinned against scripts/install-hooks.sh's jq version by a test.
//
// Exec form (`args`) is deliberate: `command` is resolved as a path, so a repo
// path containing a quote, `$` or a backtick never reaches a shell parser.
export function hooksSettingsBlock(nodeBin: string, entry: string): { hooks: Record<string, Array<{ matcher?: string; hooks: HookEntry[] }>> } {
  const h = (sub: Subcommand, timeout: number, extra: Partial<HookEntry> = {}): HookEntry => ({
    type: 'command', command: nodeBin, args: [entry, sub], timeout, ...extra,
  })
  return {
    hooks: {
      // NO matcher on purpose — the CLI's Notification matcher matches
      // notification_type, so a matcher here would stop the hook running for
      // every other type and kill both the message fallback and the log line
      // that discovers the real enumeration. See docs/hooks.md.
      Notification: [{ hooks: [h('notification', 5)] }],
      SessionStart: [{ matcher: 'startup|resume', hooks: [h('session-start', 5)] }],
      SessionEnd: [{ hooks: [h('session-end', 5)] }],
      UserPromptSubmit: [{ hooks: [h('prompt-submit', 10)] }],
      Stop: [{ hooks: [
        h('stop', 10, { statusMessage: 'Checking agent-inbox for answered questions…' }),
        h('watch', 1800, {
          statusMessage: 'Arming agent-inbox answer watcher…',
          asyncRewake: true,
          rewakeSummary: 'Agent Inbox: your answer arrived',
        }),
      ] }],
    },
  }
}

// ── pure predicates ─────────────────────────────────────────────────────────

// n-th insert waits 2^(n-1) × base before another is allowed, capped at 4h.
export function backoffMs(insertCount: number, base: number): number {
  const k = Math.max(1, Math.floor(insertCount))
  return Math.min(base * 2 ** (k - 1), MAX_BACKOFF_MS)
}

export interface BackstopInput {
  pending: Item[]
  sessionId: string
  nowMs: number
  marker: SessionMarker | null
  opts: HookOpts
}

// The whole "is this worth the human's attention" decision, in one pure place.
// Every clause exists to keep the badge trustworthy (tenet 2): a backstop that
// cannot stop firing is exactly the nag the viewer rebuild was designed against.
export function shouldBackstop({ pending, sessionId, nowMs, marker, opts }: BackstopInput): boolean {
  // (A) one live backstop per session — never stack. NOTE: this is why
  // cmdNotification must NOT sweep this session's items before reading; doing
  // so would make the clause unreachable AND destroy a flag the human may not
  // have seen yet.
  if (pending.some((p) => p.agent === 'hook' && p.session === sessionId)) return false
  // (B) a real agent already flagged in this project, recently, and is still
  // waiting — do not double-ping. Deliberately project-wide (listPending is
  // project-scoped); documented as a tradeoff in docs/hooks.md.
  for (const p of pending) {
    if (p.agent === 'hook' || p.reply) continue
    const age = nowMs - Date.parse(p.created_at)
    if (Number.isFinite(age) && age < opts.recentMs) return false
  }
  if (marker) {
    // (C) hard cap per session
    if (marker.insertCount >= opts.maxPerSession) return false
    // (D) exponential burst damping — also respects a human who just dismissed
    if (marker.insertCount > 0 && nowMs - marker.lastInsertAt < backoffMs(marker.insertCount, opts.cooldownMs)) return false
  }
  return true
}

export function nudgeText(count: number, project: string): string {
  return (
    `agent-inbox: the human answered ${count} of your open question(s) in project ${project} — ` +
    `call the agent-inbox \`pending\` tool now, act on the reply (and reply_context), then \`resolve\` the item. ` +
    `If this session has no pending tool, read the reply from the viewer API ` +
    `(curl -s localhost:4319/api/items) and tell the human this session predates it and needs a restart.`
  )
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

// stdin is arbitrary JSON. Anything not a plain object is "no event"; every
// field is read defensively and wrong-typed fields are dropped, not coerced.
export function parseEvent(text: string): HookEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const ev: HookEvent = {}
  const s = (k: keyof HookEvent & string): void => {
    const v = str(o[k])
    if (v !== undefined) (ev as Record<string, unknown>)[k] = v
  }
  s('session_id'); s('transcript_path'); s('cwd'); s('hook_event_name')
  s('notification_type'); s('message'); s('reason'); s('source')
  if (typeof o.stop_hook_active === 'boolean') ev.stop_hook_active = o.stop_hook_active
  return ev
}

// A session id off stdin becomes a filename; `../../inbox` must not escape the
// state directory. Anything not obviously safe is hashed instead of rejected,
// so the rate limiter still works for exotic ids.
export function safeSegment(raw: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return raw
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

// ── paths + diagnostics (never stdout, never stderr) ────────────────────────

function dbPathFrom(env: Env): string {
  return env.AGENT_INBOX_DB ?? defaultDbPath()
}

function stateDir(dbPath: string): string {
  return join(dirname(dbPath), 'hook-state')
}

function markerPath(dbPath: string, sessionId: string): string {
  return join(stateDir(dbPath), `${safeSegment(sessionId)}.json`)
}

function readMarker(dbPath: string, sessionId: string): SessionMarker | null {
  try {
    const raw = JSON.parse(readFileSync(markerPath(dbPath, sessionId), 'utf8')) as unknown
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    return {
      insertCount: typeof o.insertCount === 'number' ? o.insertCount : 0,
      lastInsertAt: typeof o.lastInsertAt === 'number' ? o.lastInsertAt : 0,
      pendingPromptAt: typeof o.pendingPromptAt === 'number' ? o.pendingPromptAt : null,
      transcript:
        o.transcript && typeof o.transcript === 'object'
          ? (o.transcript as { mtimeMs: number; size: number })
          : null,
    }
  } catch {
    return null
  }
}

function writeMarker(dbPath: string, sessionId: string, marker: SessionMarker): void {
  try {
    mkdirSync(stateDir(dbPath), { recursive: true })
    writeFileSync(markerPath(dbPath, sessionId), JSON.stringify(marker))
  } catch {
    /* fail open: a marker we cannot persist only costs rate limiting */
  }
}

// Diagnostics go here and nowhere else — stdout is the harness contract and
// stderr is the model-visible channel for the exit-2 nudge.
function logLine(dbPath: string, msg: string): void {
  try {
    const file = join(dirname(dbPath), 'hook.log')
    if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) rmSync(file, { force: true })
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* nothing to do — never let logging break a hook */
  }
}

// ── self-clearing sweeps: the half that keeps the badge trustworthy ─────────

// The human came back: this session's backstop has done its job.
function sweepSession(db: Database.Database, project: string, sessionId: string): number {
  let n = 0
  for (const p of listPending(db, project)) {
    if (p.agent === 'hook' && p.session === sessionId) {
      resolveItem(db, p.id)
      n++
    }
  }
  return n
}

// Janitor for sessions that died without any further hook event. Inclusive
// (`>=`) so that AGENT_INBOX_HOOK_MAX_AGE_MS=0 deterministically means "clear
// every backstop", rather than racing the millisecond an item was written in.
export function sweepStale(db: Database.Database, nowMs: number, maxAgeMs: number): number {
  let n = 0
  for (const it of listItems(db, { status: 'open' })) {
    if (it.agent !== 'hook' || it.kind !== 'question') continue
    const age = nowMs - Date.parse(it.created_at)
    if (Number.isFinite(age) && age >= maxAgeMs) {
      resolveItem(db, it.id)
      n++
    }
  }
  return n
}

// how many of this project's open questions have an answer nobody picked up
function unpickedReplies(pending: Item[]): number {
  return pending.filter((p) => p.reply != null && p.reply !== '' && p.reply_seen_at == null).length
}

// ── the dispatcher ──────────────────────────────────────────────────────────

const EMPTY: HookResult = { stdout: '' }

interface Ctx {
  sub: Subcommand
  ev: HookEvent
  env: Env
  opts: HookOpts
  dbPath: string
  nowMs: number
}

// Never throws, for any subcommand, for any stdin. The CLI entry adds a second
// belt (unhandledRejection → exit 0); this is the braces.
export async function runHook(argv: string[], stdinText: string, env: Env = process.env): Promise<HookResult> {
  const sub = argv[0]
  if (env.AGENT_INBOX_HOOKS === '0') return EMPTY
  if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) return EMPTY
  const dbPath = dbPathFrom(env)
  try {
    if (sub === 'selftest') return cmdSelftest(dbPath)
    // Latency guard: before the MCP server has ever run there is nothing to
    // read, and a per-prompt hook must not pay for a git call to learn that.
    if (!existsSync(dbPath)) return EMPTY
    let ev = parseEvent(stdinText)
    // the deferred committer is launched detached with its payload in ARGV, not
    // on stdin — see armCommitter
    if (!ev && sub === 'notification-commit') ev = parseEvent(argv[1] ?? '')
    if (!ev && sub === 'sweep') ev = {}
    if (!ev) return EMPTY
    const ctx: Ctx = { sub: sub as Subcommand, ev, env, opts: hookOpts(env), dbPath, nowMs: Date.now() }
    switch (ctx.sub) {
      case 'notification': return cmdNotification(ctx)
      case 'notification-commit': return await cmdNotificationCommit(ctx)
      case 'watch': return await cmdWatch(ctx)
      case 'sweep': return cmdSweep(ctx)
      default: return cmdSessionStep(ctx)
    }
  } catch (err) {
    logLine(dbPath, `${sub}: ${err instanceof Error ? err.message : String(err)}`)
    return EMPTY
  }
}

// selftest is the ONE subcommand allowed to fail loudly: the installer runs it
// to prove the resolved Node can actually load better-sqlite3 before it writes
// anything into the user's ~/.claude/settings.json (the Node-26 hazard).
function cmdSelftest(dbPath: string): HookResult {
  try {
    const db = openDb(dbPath)
    const n = listItems(db, { status: 'open' }).length
    db.close()
    return { stdout: `agent-inbox hook: ok — ${dbPath} readable, ${n} open item(s)\n` }
  } catch (err) {
    return { stdout: '', stderr: `agent-inbox hook selftest FAILED: ${err instanceof Error ? err.message : String(err)}\n`, exitCode: 1 }
  }
}

function scopeOf(ev: HookEvent): { project: string; stream: string; cwd: string } {
  const cwd = ev.cwd ?? process.cwd()
  return { project: inferProject(cwd), stream: inferStream(cwd), cwd }
}

// ── #10: the notification backstop ──────────────────────────────────────────

function notifyGate(ctx: Ctx): boolean {
  const type = ctx.ev.notification_type
  // Registered with NO matcher on purpose: the CLI's Notification matcher
  // matches notification_type, so a matcher here would make this gate — and the
  // log line below, which is how the real enumeration gets discovered — dead.
  logLine(ctx.dbPath, `notification type=${type ?? '(absent)'} msg=${(ctx.ev.message ?? '').slice(0, 120)}`)
  if (type !== undefined) return ctx.opts.notifyTypes.includes(type)
  return PROMPT_MESSAGE_RE.test(ctx.ev.message ?? '')
}

function transcriptStat(path: string | undefined): { mtimeMs: number; size: number } | null {
  if (!path) return null
  try {
    const s = statSync(path)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

// Phase 1 of the backstop: ARM only. A permission prompt the human answers in
// twenty seconds must not earn an inbox row (and, in the packaged app, a native
// desktop notification that cannot be withdrawn) — so nothing is written here.
function cmdNotification(ctx: Ctx): HookResult {
  const db = openDb(ctx.dbPath)
  try {
    // sweepStale only. Sweeping THIS session here would make suppression rule
    // (A) unreachable and would silently destroy a still-relevant flag.
    sweepStale(db, ctx.nowMs, ctx.opts.maxAgeMs)
    if (!notifyGate(ctx)) return EMPTY
    const sessionId = ctx.ev.session_id
    if (!sessionId) {
      logLine(ctx.dbPath, 'notification: no session_id — cannot rate-limit, skipping')
      return EMPTY
    }
    const marker = readMarker(ctx.dbPath, sessionId)
    // a committer is already in flight for this session
    if (marker?.pendingPromptAt && ctx.nowMs - marker.pendingPromptAt < ctx.opts.graceMs) return EMPTY
    const { project } = scopeOf(ctx.ev)
    if (!shouldBackstop({ pending: listPending(db, project), sessionId, nowMs: ctx.nowMs, marker, opts: ctx.opts })) return EMPTY
    writeMarker(ctx.dbPath, sessionId, {
      insertCount: marker?.insertCount ?? 0,
      lastInsertAt: marker?.lastInsertAt ?? 0,
      pendingPromptAt: ctx.nowMs,
      transcript: transcriptStat(ctx.ev.transcript_path),
    })
    armCommitter(ctx)
    return EMPTY
  } finally {
    db.close()
  }
}

// Re-launch ourselves, detached, to make the grace-window decision. The CLI
// entry passes its own resolved path in AGENT_INBOX_HOOK_ENTRY; without it
// (a programmatic caller, or a test) arming happens and nothing commits, which
// is the fail-open direction — a missed backstop, never a spurious one.
function armCommitter(ctx: Ctx): void {
  const entry = ctx.env.AGENT_INBOX_HOOK_ENTRY
  if (!entry) {
    logLine(ctx.dbPath, 'notification: armed but AGENT_INBOX_HOOK_ENTRY is unset — no committer spawned')
    return
  }
  // The payload rides in ARGV, not on the child's stdin: hook-cli.ts calls
  // process.exit() the instant this returns, which would not flush a pipe.
  // Only the four fields the committer reads, and the message bounded.
  const payload = JSON.stringify({
    session_id: ctx.ev.session_id,
    cwd: ctx.ev.cwd,
    transcript_path: ctx.ev.transcript_path,
    message: (ctx.ev.message ?? '').slice(0, 500),
  })
  try {
    // execArgv is forwarded so this works under `tsx` as well as plain node
    const child = spawn(process.execPath, [...process.execArgv, entry, 'notification-commit', payload], {
      detached: true,
      stdio: 'ignore',
      env: { ...ctx.env } as NodeJS.ProcessEnv,
    })
    child.unref()
  } catch (err) {
    logLine(ctx.dbPath, `notification: committer spawn failed — ${err instanceof Error ? err.message : String(err)}`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

// Phase 2: the grace window has elapsed. Insert only if the session is STILL
// stuck — the marker un-armed (the human's next step cleared it) or a grown
// transcript (the agent carried on working) both stand this down.
async function cmdNotificationCommit(ctx: Ctx): Promise<HookResult> {
  const sessionId = ctx.ev.session_id
  if (!sessionId) return EMPTY
  const armed = readMarker(ctx.dbPath, sessionId)
  if (!armed?.pendingPromptAt) return EMPTY
  const wait = armed.pendingPromptAt + ctx.opts.graceMs - Date.now()
  if (wait > 0) await delay(wait)

  const marker = readMarker(ctx.dbPath, sessionId)
  if (!marker?.pendingPromptAt || marker.pendingPromptAt !== armed.pendingPromptAt) return EMPTY
  const now = transcriptStat(ctx.ev.transcript_path)
  if (now && marker.transcript && (now.mtimeMs !== marker.transcript.mtimeMs || now.size !== marker.transcript.size)) {
    disarm(ctx.dbPath, sessionId)
    return EMPTY
  }
  const db = openDb(ctx.dbPath)
  try {
    sweepStale(db, Date.now(), ctx.opts.maxAgeMs)
    const { project, stream, cwd } = scopeOf(ctx.ev)
    const nowMs = Date.now()
    if (!shouldBackstop({ pending: listPending(db, project), sessionId, nowMs, marker, opts: ctx.opts })) {
      disarm(ctx.dbPath, sessionId)
      return EMPTY
    }
    insertItem(db, {
      project,
      stream,
      agent: 'hook',
      session: sessionId,
      kind: 'question',
      title: `Waiting on a permission prompt in ${project}`,
      detail: 'Claude Code is blocked at the terminal — the agent did not flag this itself.',
      context: [
        ctx.ev.message ?? '(no message)',
        `cwd: ${cwd}`,
        stream ? `branch: ${stream}` : '',
        `session: ${sessionId}`,
        'Raised by the agent-inbox backstop hook (agent: hook), not by the agent. It auto-resolves the moment that session takes another step, and a janitor clears it after 24h. See docs/hooks.md.',
      ].filter(Boolean).join('\n'),
    })
    writeMarker(ctx.dbPath, sessionId, {
      insertCount: (marker.insertCount ?? 0) + 1,
      lastInsertAt: nowMs,
      pendingPromptAt: null,
      transcript: null,
    })
    return EMPTY
  } finally {
    db.close()
  }
}

function disarm(dbPath: string, sessionId: string): void {
  const m = readMarker(dbPath, sessionId)
  if (!m) return
  writeMarker(dbPath, sessionId, { ...m, pendingPromptAt: null, transcript: null })
}

// ── #21 + self-clearing: every other session-scoped subcommand ──────────────

// stop / session-start / session-end / prompt-submit share one shape: sweep
// first (the human came back), then answer the "is a reply waiting?" question
// in whichever dialect that hook event speaks.
function cmdSessionStep(ctx: Ctx): HookResult {
  const db = openDb(ctx.dbPath)
  try {
    const { project } = scopeOf(ctx.ev)
    sweepStale(db, ctx.nowMs, ctx.opts.maxAgeMs)
    if (ctx.ev.session_id) {
      sweepSession(db, project, ctx.ev.session_id)
      disarm(ctx.dbPath, ctx.ev.session_id)
    }
    if (ctx.sub === 'session-end') return EMPTY
    const n = unpickedReplies(listPending(db, project))
    if (n === 0) return EMPTY
    const text = nudgeText(n, project)
    if (ctx.sub === 'prompt-submit') {
      // VERIFIED: additionalContext must be nested inside hookSpecificOutput —
      // a top-level copy is not ignored, it earns a user-visible
      // "unrecognized keys" warning on every nudge.
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text }, suppressOutput: true }) }
    }
    if (ctx.sub === 'stop') {
      // The loop guard is non-negotiable: blocking twice in a row traps the
      // human in a session they cannot exit.
      if (ctx.ev.stop_hook_active === true) return EMPTY
      return { stdout: JSON.stringify({ decision: 'block', reason: text }) }
    }
    return { stdout: `${text}\n` } // session-start: plain stdout is added to context
  } finally {
    db.close()
  }
}

function cmdSweep(ctx: Ctx): HookResult {
  const db = openDb(ctx.dbPath)
  try {
    sweepStale(db, ctx.nowMs, ctx.opts.maxAgeMs)
    return EMPTY
  } finally {
    db.close()
  }
}

// ── #21's async half: the answer watcher ────────────────────────────────────

function lockPath(dbPath: string, project: string): string {
  return join(stateDir(dbPath), `watch-${safeSegment(project)}.lock`)
}

function lockHeld(file: string): boolean {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Runs on Stop with asyncRewake: poll until the human answers, then exit 2 —
// which is what wakes the model. stderr carries the payload, so the shell
// wrapper must NOT redirect it.
async function cmdWatch(ctx: Ctx): Promise<HookResult> {
  const { project } = scopeOf(ctx.ev)
  const db = openDb(ctx.dbPath) // opened ONCE for the whole loop
  const lock = lockPath(ctx.dbPath, project)
  let held = false
  try {
    if (listPending(db, project).filter((p) => !p.reply).length === 0) return EMPTY
    if (lockHeld(lock)) return EMPTY
    mkdirSync(stateDir(ctx.dbPath), { recursive: true })
    writeFileSync(lock, String(process.pid))
    held = true
    const deadline = Date.now() + ctx.opts.watchSecs * 1000
    while (Date.now() < deadline) {
      const pending = listPending(db, project)
      const n = unpickedReplies(pending)
      if (n > 0) return { stdout: '', stderr: `${nudgeText(n, project)}\n`, exitCode: 2 }
      if (pending.length === 0) return EMPTY // resolved out from under us — stand down
      await delay(ctx.opts.watchPollMs)
    }
    return EMPTY
  } finally {
    db.close()
    if (held) { try { unlinkSync(lock) } catch { /* already gone */ } }
  }
}
