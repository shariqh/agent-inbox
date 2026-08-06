import { describe, it, expect } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  shouldBackstop, backoffMs, nudgeText, parseEvent, safeSegment, hookOpts,
  runHook, sweepStale, hooksSettingsBlock, SUBCOMMANDS,
} from '../src/hook.js'
import type { SessionMarker } from '../src/hook.js'
import { openDb, insertItem, listItems, replyItem, markReplySeen, resolveItem } from '../src/store.js'
import type { Item } from '../src/store.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const NOW = Date.parse('2026-07-26T12:00:00Z')

function q(over: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    project: 'agent-inbox',
    stream: 'main',
    agent: 'claude-code',
    session: null,
    kind: 'question',
    title: 'which storage?',
    detail: '',
    next_step: '',
    action_owner: null,
    impact: '',
    next_after: '',
    context: '',
    status: 'open',
    annotation: null,
    options: null,
    reply: null,
    reply_context: null,
    replied_at: null,
    reply_seen_at: null,
    reply_source: null,
    reply_kind: null,
    snoozed_until: null,
    outcome: '',
    outcome_at: null,
    repo: null,
    issue_ref: null,
    created_at: new Date(NOW - 60_000).toISOString(),
    updated_at: new Date(NOW - 60_000).toISOString(),
    resolved_at: null,
    ...over,
  }
}

const OPTS = hookOpts({})

describe('hook: suppression rules', () => {
  it('is true for a session with nothing open and no marker', () => {
    expect(shouldBackstop({ pending: [], sessionId: 'S1', nowMs: NOW, marker: null, opts: OPTS })).toBe(true)
  })

  it('is false while this session already has an open hook-authored question', () => {
    const pending = [q({ id: 'h', agent: 'hook', session: 'S1' })]
    expect(shouldBackstop({ pending, sessionId: 'S1', nowMs: NOW, marker: null, opts: OPTS })).toBe(false)
    // another session's backstop says nothing about this one
    expect(shouldBackstop({ pending, sessionId: 'S2', nowMs: NOW, marker: null, opts: OPTS })).toBe(true)
  })

  it('is false when a real agent flagged in this project inside RECENT_MS, and true once it ages out', () => {
    const fresh = [q({ created_at: new Date(NOW - 60_000).toISOString() })]
    expect(shouldBackstop({ pending: fresh, sessionId: 'S1', nowMs: NOW, marker: null, opts: OPTS })).toBe(false)
    const old = [q({ created_at: new Date(NOW - OPTS.recentMs - 1000).toISOString() })]
    expect(shouldBackstop({ pending: old, sessionId: 'S1', nowMs: NOW, marker: null, opts: OPTS })).toBe(true)
  })

  it('ignores an already-answered agent question when damping (the human is not being double-pinged)', () => {
    const answered = [q({ reply: 'go with sqlite' })]
    expect(shouldBackstop({ pending: answered, sessionId: 'S1', nowMs: NOW, marker: null, opts: OPTS })).toBe(true)
  })

  it('backs off exponentially from the last insert and caps at four hours', () => {
    expect(backoffMs(1, 1000)).toBe(1000)
    expect(backoffMs(2, 1000)).toBe(2000)
    expect(backoffMs(3, 1000)).toBe(4000)
    expect(backoffMs(99, 1000)).toBe(4 * 60 * 60 * 1000)
    expect(backoffMs(0, 1000)).toBe(1000) // clamped, never a fractional window
  })

  it('is false inside the backoff window and true once it has elapsed', () => {
    const marker = { insertCount: 1, lastInsertAt: NOW - 1000 }
    expect(shouldBackstop({ pending: [], sessionId: 'S1', nowMs: NOW, marker, opts: OPTS })).toBe(false)
    const elapsed = { insertCount: 1, lastInsertAt: NOW - OPTS.cooldownMs - 1 }
    expect(shouldBackstop({ pending: [], sessionId: 'S1', nowMs: NOW, marker: elapsed, opts: OPTS })).toBe(true)
  })

  it('is false once insertCount reaches the per-session cap, however long ago', () => {
    const marker = { insertCount: OPTS.maxPerSession, lastInsertAt: NOW - 30 * 24 * 60 * 60 * 1000 }
    expect(shouldBackstop({ pending: [], sessionId: 'S1', nowMs: NOW, marker, opts: OPTS })).toBe(false)
  })
})

describe('hook: options and parsing', () => {
  it('hookOpts reads the documented env overrides and falls back to the defaults', () => {
    const d = hookOpts({})
    expect(d.recentMs).toBe(30 * 60_000)
    expect(d.cooldownMs).toBe(10 * 60_000)
    expect(d.maxPerSession).toBe(3)
    expect(d.maxAgeMs).toBe(24 * 60 * 60 * 1000)
    // the grace window is the whole point of the two-phase backstop; a default of
    // 0 would make every permission prompt an instant inbox row, and nothing else
    // in this file would notice (freshEnv pins GRACE_MS=0 for the runtime tests)
    expect(d.graceMs).toBe(90_000)
    expect(d.notifyTypes).toEqual(['permission_prompt']) // idle_prompt is deliberately OFF
    const o = hookOpts({
      AGENT_INBOX_HOOK_RECENT_MS: '1',
      AGENT_INBOX_HOOK_COOLDOWN_MS: '2',
      AGENT_INBOX_HOOK_MAX_PER_SESSION: '9',
      AGENT_INBOX_HOOK_MAX_AGE_MS: '3',
      AGENT_INBOX_HOOK_GRACE_MS: '4',
      AGENT_INBOX_HOOK_NOTIFY_TYPES: 'permission_prompt, idle_prompt',
    })
    expect(o).toMatchObject({ recentMs: 1, cooldownMs: 2, maxPerSession: 9, maxAgeMs: 3, graceMs: 4 })
    expect(o.notifyTypes).toEqual(['permission_prompt', 'idle_prompt'])
  })

  it('a garbage env value falls back to the default rather than producing NaN windows', () => {
    expect(hookOpts({ AGENT_INBOX_HOOK_RECENT_MS: 'soon' }).recentMs).toBe(30 * 60_000)
    expect(hookOpts({ AGENT_INBOX_HOOK_MAX_PER_SESSION: '-4' }).maxPerSession).toBe(3)
  })

  it('parseEvent returns null for anything that is not a JSON object', () => {
    for (const bad of ['', '   ', 'not json', 'null', '[]', '42', '"str"', 'true']) {
      expect(parseEvent(bad)).toBeNull()
    }
  })

  it('parseEvent reads the documented fields defensively and drops wrong-typed ones', () => {
    const ev = parseEvent(JSON.stringify({
      session_id: 'S1', cwd: '/tmp/x', hook_event_name: 'Notification',
      notification_type: 'permission_prompt', message: 'Claude needs your permission',
      stop_hook_active: true, source: 'startup', extra: 'ignored',
    }))
    expect(ev).toEqual({
      session_id: 'S1', cwd: '/tmp/x', hook_event_name: 'Notification',
      notification_type: 'permission_prompt', message: 'Claude needs your permission',
      stop_hook_active: true, source: 'startup',
    })
    const weird = parseEvent(JSON.stringify({ session_id: 12, stop_hook_active: 'yes', cwd: null }))
    expect(weird).toEqual({})
  })

  it('safeSegment refuses a path-traversing session id and never returns an empty name', () => {
    expect(safeSegment('abc-123_XYZ')).toBe('abc-123_XYZ')
    expect(safeSegment('../../inbox')).not.toContain('..')
    expect(safeSegment('../../inbox')).toMatch(/^[a-f0-9]{16}$/)
    expect(safeSegment('')).toMatch(/^[a-f0-9]{16}$/)
    expect(safeSegment('a'.repeat(200))).toMatch(/^[a-f0-9]{16}$/)
  })

  it('nudgeText names the project, the count and the pending tool', () => {
    const t = nudgeText(2, 'agent-inbox')
    expect(t).toContain('agent-inbox')
    expect(t).toContain('2')
    expect(t).toContain('pending')
    expect(t).toContain('resolve')
  })

  it('SUBCOMMANDS is the dispatcher contract the docs are checked against', () => {
    expect(SUBCOMMANDS).toContain('notification')
    expect(SUBCOMMANDS).toContain('watch')
    expect(SUBCOMMANDS).toContain('selftest')
  })
})

// ── everything below drives the real runtime against a real temp SQLite db ──

// GRACE_MS=0 collapses the two-phase backstop into one step so the arm/commit
// pair can be driven synchronously. The cost is that BOTH of the runtime's grace
// comparisons — the in-flight-committer guard and the committer's own wait — are
// unreachable under this default, so anything that depends on the window must
// override it. The two tests that do are marked as such below; do not add a third
// grace assertion that quietly inherits the 0.
function freshEnv(extra: Record<string, string> = {}): { env: Record<string, string>; dbPath: string } {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'hook-')), 'inbox.db')
  openDb(dbPath).close() // the runtime deliberately no-ops until the db exists
  return { env: { AGENT_INBOX_DB: dbPath, AGENT_INBOX_HOOK_GRACE_MS: '0', ...extra }, dbPath }
}

function ev(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: 'S1', cwd: process.cwd(), notification_type: 'permission_prompt', message: 'Claude needs your permission to run Bash', ...over })
}

// the deferred commit is what actually writes the row; the notification hook
// only arms it (see docs/hooks.md — the grace window)
async function backstop(env: Record<string, string>, over: Record<string, unknown> = {}): Promise<void> {
  await runHook(['notification'], ev(over), env)
  await runHook(['notification-commit'], ev(over), env)
}

describe('hook: fail-open contract', () => {
  it('never throws and writes nothing on malformed, empty or non-object stdin', async () => {
    const { env, dbPath } = freshEnv()
    for (const bad of ['', 'not json', 'null', '[]', '42']) {
      await expect(runHook(['notification'], bad, env)).resolves.toEqual({ stdout: '' })
    }
    expect(listItems(openDb(dbPath))).toHaveLength(0)
  })

  it('AGENT_INBOX_HOOKS=0 makes every subcommand a silent no-op', async () => {
    const { env, dbPath } = freshEnv({ AGENT_INBOX_HOOKS: '0' })
    for (const sub of SUBCOMMANDS) expect(await runHook([sub], ev(), env)).toEqual({ stdout: '' })
    expect(listItems(openDb(dbPath))).toHaveLength(0)
  })

  it('an unknown subcommand, and no subcommand at all, write nothing and exit 0', async () => {
    const { env, dbPath } = freshEnv()
    expect(await runHook(['nope'], ev(), env)).toEqual({ stdout: '' })
    expect(await runHook([], ev(), env)).toEqual({ stdout: '' })
    expect(listItems(openDb(dbPath))).toHaveLength(0)
  })

  it('a db path that cannot be opened is logged, not thrown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-bad-'))
    const dbPath = join(dir, 'inbox.db')
    writeFileSync(dbPath, 'not a database')
    const env = { AGENT_INBOX_DB: dbPath, AGENT_INBOX_HOOK_GRACE_MS: '0' }
    await expect(backstop(env)).resolves.toBeUndefined()
    expect(readFileSync(join(dir, 'hook.log'), 'utf8')).toMatch(/notification: .*not a database/)
  })

  it('does nothing at all before the db exists (the per-prompt latency guard)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'hook-none-')), 'inbox.db')
    const env = { AGENT_INBOX_DB: dbPath, AGENT_INBOX_HOOK_GRACE_MS: '0' }
    expect(await runHook(['prompt-submit'], ev(), env)).toEqual({ stdout: '' })
    expect(existsSync(dbPath)).toBe(false)
  })
})

describe('hook: notification backstop (#10)', () => {
  it('inserts exactly one open question attributed to the hook and the harness session', async () => {
    const { env, dbPath } = freshEnv()
    expect(await runHook(['notification'], ev(), env)).toEqual({ stdout: '' })
    const items = listItems(openDb(dbPath))
    expect(items).toHaveLength(0) // armed only — the grace window has not been committed yet
    expect(await runHook(['notification-commit'], ev(), env)).toEqual({ stdout: '' })
    const after = listItems(openDb(dbPath))
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ kind: 'question', status: 'open', agent: 'hook', session: 'S1', project: 'agent-inbox' })
    expect(after[0]!.title).toMatch(/permission prompt/i)
    expect(after[0]!.context).toMatch(/backstop hook/)
  })

  it('a second permission prompt leaves the FIRST item open and inserts nothing', async () => {
    const { env, dbPath } = freshEnv()
    await backstop(env)
    const first = listItems(openDb(dbPath))[0]!
    await backstop(env)
    const items = listItems(openDb(dbPath))
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe(first.id)
    expect(items[0]!.status).toBe('open') // never resolved out from under the human
  })

  it('is suppressed while a real agent question in this project is fresh', async () => {
    const { env, dbPath } = freshEnv()
    const db = openDb(dbPath)
    insertItem(db, { project: 'agent-inbox', stream: 'main', agent: 'claude-code', kind: 'question', title: 'already asked' })
    await backstop(env)
    expect(listItems(db).filter((i) => i.agent === 'hook')).toHaveLength(0)
  })

  it('ignores notification types outside AGENT_INBOX_HOOK_NOTIFY_TYPES, and honours the opt-in', async () => {
    const { env, dbPath } = freshEnv()
    await backstop(env, { notification_type: 'auth_success' })
    await backstop(env, { notification_type: 'idle_prompt' })
    expect(listItems(openDb(dbPath))).toHaveLength(0)
    const optIn = { ...env, AGENT_INBOX_HOOK_NOTIFY_TYPES: 'permission_prompt,idle_prompt' }
    await backstop(optIn, { notification_type: 'idle_prompt' })
    expect(listItems(openDb(dbPath))).toHaveLength(1)
  })

  it('logs every received notification_type so the real enumeration self-documents', async () => {
    const { env, dbPath } = freshEnv()
    await runHook(['notification'], ev({ notification_type: 'elicitation_dialog' }), env)
    expect(readFileSync(join(dirname(dbPath), 'hook.log'), 'utf8')).toContain('elicitation_dialog')
  })

  it('falls back to matching the message when the CLI sends no notification_type', async () => {
    const { env, dbPath } = freshEnv()
    const noType = JSON.stringify({ session_id: 'S1', cwd: process.cwd(), message: 'Claude needs your permission to use Bash' })
    await runHook(['notification'], noType, env)
    await runHook(['notification-commit'], noType, env)
    expect(listItems(openDb(dbPath))).toHaveLength(1)
    const chatty = JSON.stringify({ session_id: 'S2', cwd: process.cwd(), message: 'all done' })
    await runHook(['notification'], chatty, env)
    await runHook(['notification-commit'], chatty, env)
    expect(listItems(openDb(dbPath))).toHaveLength(1)
  })

  it('inserts nothing when the prompt is answered inside the grace window', async () => {
    const { env, dbPath } = freshEnv({ AGENT_INBOX_HOOK_GRACE_MS: '60000' })
    await runHook(['notification'], ev(), env)
    // the human answered: the session took its next step, which clears the arming
    await runHook(['prompt-submit'], ev(), env)
    await runHook(['notification-commit'], ev(), env)
    expect(listItems(openDb(dbPath))).toHaveLength(0)
  })

  // ── the two assertions that need a REALISTIC grace window ─────────────────
  // freshEnv pins GRACE_MS=0 file-wide (see the note there), which makes both of
  // the runtime's grace comparisons unreachable: delete either one and all 79
  // other tests here stay green. Both are load-bearing, so both are driven at a
  // window a human could actually answer inside.

  // Without the in-flight guard, every prompt re-arms — the committer's deadline
  // (pendingPromptAt + graceMs) is pushed forward on each one, so a prompt stream
  // more frequent than the 90s default means the backstop NEVER fires. That is
  // precisely the failure #10 exists to prevent, and it is invisible in the db:
  // nothing is written either way, so only the marker can witness it.
  it('a second prompt inside the grace window does NOT push the committer deadline out', async () => {
    const { env, dbPath } = freshEnv({ AGENT_INBOX_HOOK_GRACE_MS: '60000' })
    const armedAt = (): number | null | undefined =>
      (JSON.parse(readFileSync(join(dirname(dbPath), 'hook-state', 'S1.json'), 'utf8')) as SessionMarker).pendingPromptAt
    await runHook(['notification'], ev(), env)
    const first = armedAt()!
    expect(first).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 30)) // a real gap, so a re-arm would be visible
      await runHook(['notification'], ev(), env)
      expect(armedAt(), `prompt ${i + 2} moved the deadline`).toBe(first)
    }
    expect(listItems(openDb(dbPath))).toHaveLength(0) // still armed, still uncommitted
  })

  // The other half: the committer must SLEEP OUT the window rather than decide at
  // the instant it starts. Deciding immediately would give an ordinary prompt the
  // human answers in twenty seconds an inbox row — and, in the packaged app, a
  // desktop notification that cannot be withdrawn.
  it('the committer waits out the grace window instead of deciding the moment it starts', async () => {
    const { env, dbPath } = freshEnv({ AGENT_INBOX_HOOK_GRACE_MS: '400' })
    await runHook(['notification'], ev(), env)
    const commit = runHook(['notification-commit'], ev(), env) // starts its wait now
    // the human answers 100ms in: the session's next step disarms the marker
    setTimeout(() => { void runHook(['prompt-submit'], ev(), env) }, 100)
    expect(await commit).toEqual({ stdout: '' })
    expect(listItems(openDb(dbPath))).toHaveLength(0)
  })

  it('stands down when the transcript grew during the grace window (the session moved on)', async () => {
    const { env, dbPath } = freshEnv()
    const transcript = join(dirname(dbPath), 'transcript.jsonl')
    writeFileSync(transcript, '{"a":1}\n')
    const payload = ev({ transcript_path: transcript })
    await runHook(['notification'], payload, env)
    writeFileSync(transcript, '{"a":1}\n{"b":2}\n')
    await runHook(['notification-commit'], payload, env)
    expect(listItems(openDb(dbPath))).toHaveLength(0)
  })

  it('backs off and then stops entirely after the per-session cap', async () => {
    const { env, dbPath } = freshEnv({ AGENT_INBOX_HOOK_COOLDOWN_MS: '0', AGENT_INBOX_HOOK_MAX_PER_SESSION: '2' })
    const db = openDb(dbPath)
    for (let i = 0; i < 5; i++) {
      await backstop(env)
      // clear the way for the next one exactly as a returning human would
      await runHook(['prompt-submit'], ev(), env)
    }
    expect(listItems(db).filter((i) => i.agent === 'hook')).toHaveLength(2)
  })
})

describe('hook: self-clearing (the trustworthy badge)', () => {
  for (const sub of ['stop', 'session-end', 'prompt-submit', 'session-start'] as const) {
    it(`${sub} resolves this session's open backstop item`, async () => {
      const { env, dbPath } = freshEnv()
      await backstop(env)
      const db = openDb(dbPath)
      expect(listItems(db, { status: 'open' })).toHaveLength(1)
      await runHook([sub], ev(), env)
      expect(listItems(db, { status: 'open' })).toHaveLength(0)
      expect(listItems(db, { status: 'resolved' })).toHaveLength(1)
    })
  }

  it("never resolves another session's backstop nor any agent-authored question", async () => {
    const { env, dbPath } = freshEnv()
    await backstop(env, { session_id: 'S1' })
    await backstop({ ...env, AGENT_INBOX_HOOK_COOLDOWN_MS: '0' }, { session_id: 'S2' })
    const db = openDb(dbPath)
    insertItem(db, { project: 'agent-inbox', stream: 'main', agent: 'claude-code', session: 'mcp-1', kind: 'question', title: 'a real flag' })
    await runHook(['stop'], ev({ session_id: 'S1' }), env)
    const open = listItems(db, { status: 'open' })
    expect(open.map((i) => i.session).sort()).toEqual(['S2', 'mcp-1'])
  })

  // Pins the INCLUSIVE cutoff in sweepStale. The subcommand test below reaches
  // the same line, but only ever with age > 0 by however many milliseconds the
  // spawn happened to take — with `>` it passes roughly two runs in three. This
  // one is arithmetic, so it cannot flap either way.
  it('sweeps at EXACTLY the cutoff (>=), so MAX_AGE_MS=0 means "clear every backstop"', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'hook-sweep-')), 'inbox.db')
    const db = openDb(dbPath)
    const mk = (): Item => {
      insertItem(db, { project: 'agent-inbox', stream: 'main', agent: 'hook', session: 'S1', kind: 'question', title: 'blocked at a prompt' })
      return listItems(db, { status: 'open' })[0]!
    }
    const DAY = 24 * 60 * 60 * 1000
    const created = Date.parse(mk().created_at)
    expect(sweepStale(db, created + DAY - 1, DAY)).toBe(0) // one tick early: it survives
    expect(sweepStale(db, created + DAY, DAY)).toBe(1)     // exactly on it: `>` would leave it

    const later = mk()
    // the documented meaning of AGENT_INBOX_HOOK_MAX_AGE_MS=0 — "clear every
    // backstop" — at the one instant that actually distinguishes `>=` from `>`
    expect(sweepStale(db, Date.parse(later.created_at), 0)).toBe(1)
  })

  it('the 24h janitor resolves orphaned backstops on any invocation', async () => {
    const { env, dbPath } = freshEnv()
    await backstop(env)
    const db = openDb(dbPath)
    // the item is 25h old as far as the sweep is concerned
    expect(sweepStale(db, Date.now() + 25 * 60 * 60 * 1000, 24 * 60 * 60 * 1000)).toBe(1)
    expect(listItems(db, { status: 'open' })).toHaveLength(0)
    // and it runs from the subcommand too
    await backstop({ ...env, AGENT_INBOX_HOOK_COOLDOWN_MS: '0' }, { session_id: 'S9' })
    expect(listItems(db, { status: 'open' })).toHaveLength(1)
    await runHook(['sweep'], ev(), { ...env, AGENT_INBOX_HOOK_MAX_AGE_MS: '0' })
    expect(listItems(db, { status: 'open' })).toHaveLength(0)
  })

  it('leaves a genuine agent question alone however old it is', async () => {
    const { env, dbPath } = freshEnv()
    const db = openDb(dbPath)
    insertItem(db, { project: 'agent-inbox', stream: 'main', agent: 'claude-code', kind: 'question', title: 'still yours' })
    await runHook(['sweep'], ev(), { ...env, AGENT_INBOX_HOOK_MAX_AGE_MS: '0' })
    expect(listItems(db, { status: 'open' })).toHaveLength(1)
  })
})

describe('hook: pickup nudge (#21)', () => {
  function answered(): { env: Record<string, string>; dbPath: string; id: string } {
    const { env, dbPath } = freshEnv()
    const db = openDb(dbPath)
    const id = insertItem(db, { project: 'agent-inbox', stream: 'main', agent: 'claude-code', kind: 'question', title: 'flags or branch?' })
    replyItem(db, id, 'flags — but canary first')
    return { env, dbPath, id }
  }

  it('prompt-submit emits additionalContext nested inside hookSpecificOutput, and nothing else', async () => {
    const { env } = answered()
    const res = await runHook(['prompt-submit'], ev(), env)
    const out = JSON.parse(res.stdout)
    expect(Object.keys(out).sort()).toEqual(['hookSpecificOutput', 'suppressOutput'])
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: 'UserPromptSubmit',
      additionalContext: expect.stringMatching(/pending/),
    })
    // a top-level copy earns a user-visible "unrecognized keys" warning
    expect(out.additionalContext).toBeUndefined()
    expect(res.exitCode).toBeUndefined()
  })

  it('emits nothing once the agent has picked the reply up', async () => {
    const { env, dbPath, id } = answered()
    const answeredItem = listItems(openDb(dbPath)).find((i) => i.id === id)!
    markReplySeen(openDb(dbPath), id, answeredItem.replied_at)
    expect(await runHook(['prompt-submit'], ev(), env)).toEqual({ stdout: '' })
    expect(await runHook(['stop'], ev(), env)).toEqual({ stdout: '' })
    expect(await runHook(['session-start'], ev(), env)).toEqual({ stdout: '' })
  })

  it('session-start emits the nudge as plain text, not JSON', async () => {
    const { env } = answered()
    const res = await runHook(['session-start'], ev({ source: 'startup' }), env)
    expect(res.stdout).toMatch(/^agent-inbox: /)
    expect(() => JSON.parse(res.stdout)).toThrow()
  })

  it('stop emits decision:block with the nudge as the reason', async () => {
    const { env } = answered()
    const out = JSON.parse((await runHook(['stop'], ev(), env)).stdout)
    expect(out.decision).toBe('block')
    expect(out.reason).toMatch(/pending/)
  })

  it('stop NEVER blocks twice — stop_hook_active is the loop guard', async () => {
    const { env } = answered()
    expect(await runHook(['stop'], ev({ stop_hook_active: true }), env)).toEqual({ stdout: '' })
  })

  it('counts only this project and never leaks another project\'s titles', async () => {
    const { env, dbPath } = answered()
    const db = openDb(dbPath)
    const other = insertItem(db, { project: 'elsewhere', stream: '', agent: 'claude-code', kind: 'question', title: 'SECRET-TITLE' })
    replyItem(db, other, 'do it')
    const out = JSON.parse((await runHook(['stop'], ev(), env)).stdout)
    expect(out.reason).toContain('1 of your open question(s)')
    expect(out.reason).not.toContain('SECRET-TITLE')
    expect(out.reason).not.toContain('elsewhere')
  })

  it('session-end stays byte-clean whatever is waiting', async () => {
    const { env } = answered()
    expect(await runHook(['session-end'], ev({ reason: 'clear' }), env)).toEqual({ stdout: '' })
  })
})

describe('hook: watch', () => {
  const fast = { AGENT_INBOX_WATCH_SECS: '4', AGENT_INBOX_WATCH_POLL_MS: '20' }

  it('exits 2 with the nudge on stderr the moment a reply lands', async () => {
    const { env, dbPath } = freshEnv(fast)
    const db = openDb(dbPath)
    const id = insertItem(db, { project: 'agent-inbox', stream: 'main', agent: 'claude-code', kind: 'question', title: 'which?' })
    const running = runHook(['watch'], ev(), env)
    setTimeout(() => replyItem(openDb(dbPath), id, 'the second one'), 100)
    const res = await running
    expect(res.exitCode).toBe(2)
    expect(res.stdout).toBe('') // stdout stays clean; stderr carries the payload
    expect(res.stderr).toMatch(/pending/)
  })

  it('exits 0 immediately when the project has no unanswered question', async () => {
    const { env, dbPath } = freshEnv(fast)
    insertItem(openDb(dbPath), { project: 'agent-inbox', stream: '', agent: 'claude-code', kind: 'note', title: 'fyi' })
    const started = Date.now()
    expect(await runHook(['watch'], ev(), env)).toEqual({ stdout: '' })
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('stands down when the last open question is resolved out from under it', async () => {
    const { env, dbPath } = freshEnv(fast)
    const db = openDb(dbPath)
    const id = insertItem(db, { project: 'agent-inbox', stream: '', agent: 'claude-code', kind: 'question', title: 'which?' })
    const running = runHook(['watch'], ev(), env)
    setTimeout(() => resolveItem(openDb(dbPath), id), 100)
    expect(await running).toEqual({ stdout: '' })
  })

  it('a second watcher for the same project stands down while the lock is held', async () => {
    const { env, dbPath } = freshEnv(fast)
    insertItem(openDb(dbPath), { project: 'agent-inbox', stream: '', agent: 'claude-code', kind: 'question', title: 'which?' })
    const first = runHook(['watch'], ev(), env)
    await new Promise((r) => setTimeout(r, 100))
    const started = Date.now()
    expect(await runHook(['watch'], ev(), env)).toEqual({ stdout: '' })
    expect(Date.now() - started).toBeLessThan(3000)
    await first
  })

  it('takes its lock beside the db, never in TMPDIR where the legacy shell watcher lives', async () => {
    const { env, dbPath } = freshEnv(fast)
    insertItem(openDb(dbPath), { project: 'agent-inbox', stream: '', agent: 'claude-code', kind: 'question', title: 'which?' })
    const running = runHook(['watch'], ev(), env)
    await new Promise((r) => setTimeout(r, 100))
    expect(existsSync(join(dirname(dbPath), 'hook-state', 'watch-agent-inbox.lock'))).toBe(true)
    await running
    expect(existsSync(join(dirname(dbPath), 'hook-state', 'watch-agent-inbox.lock'))).toBe(false)
  })
})

describe('hook: real spawn round-trip', () => {
  // mirrors test/mcp.integration.test.ts — a real child process, real stdin,
  // real exit status. Needs Node 24 active (see CLAUDE.md).
  function run(args: string[], stdin: string, env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn('npx', ['tsx', 'src/hook-cli.ts', ...args], { env: { ...process.env, ...env } })
      let out = ''; let err = ''
      child.stdout.on('data', (d) => { out += String(d) })
      child.stderr.on('data', (d) => { err += String(d) })
      child.on('close', (code) => resolve({ code, out, err }))
      child.stdin.end(stdin)
    })
  }

  it('the notification hook prints nothing, exits 0, and its detached committer lands the row', async () => {
    const { env, dbPath } = freshEnv({ AGENT_INBOX_HOOK_GRACE_MS: '150' })
    const res = await run(['notification'], ev(), env)
    expect(res.code).toBe(0)
    expect(res.out).toBe('') // the Notification channel stays byte-clean
    const db = openDb(dbPath)
    const deadline = Date.now() + 9000
    while (listItems(db).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    expect(listItems(db).map((i) => i.agent)).toEqual(['hook'])
  })

  it('the watch child exits with status 2 — the code that wakes the model', async () => {
    const { env, dbPath } = freshEnv({ AGENT_INBOX_WATCH_SECS: '8', AGENT_INBOX_WATCH_POLL_MS: '50' })
    const db = openDb(dbPath)
    const id = insertItem(db, { project: 'agent-inbox', stream: '', agent: 'claude-code', kind: 'question', title: 'which?' })
    const running = run(['watch'], ev(), env)
    const lock = join(dirname(dbPath), 'hook-state', 'watch-agent-inbox.lock')
    const deadline = Date.now() + 9000
    while (!existsSync(lock) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    const armed = existsSync(lock)
    replyItem(db, id, 'the second one')
    const res = await running
    db.close()
    expect(armed).toBe(true)
    expect(res.code).toBe(2)
    expect(res.err).toMatch(/pending/)
    expect(res.out).toBe('')
  })

  it('selftest exits 0 against a usable db and non-zero against a broken one', async () => {
    const { env } = freshEnv()
    expect((await run(['selftest'], '', env)).code).toBe(0)
    const broken = join(mkdtempSync(join(tmpdir(), 'hook-broken-')), 'inbox.db')
    writeFileSync(broken, 'not a database')
    const bad = await run(['selftest'], '', { AGENT_INBOX_DB: broken })
    expect(bad.code).not.toBe(0)
    expect(bad.err).toMatch(/selftest FAILED/)
  })

  it('the shell wrapper stays silent when dist/ is unbuilt', async () => {
    const wrapper = join(REPO, 'hooks', 'agent-inbox-hook.sh')
    const src = readFileSync(wrapper, 'utf8')
    // the redirect that would delete the exit-2 payload the model is woken with
    expect(src).not.toMatch(/2>>/)
    // the hook is invoked with BOTH streams intact
    expect(src).toMatch(/^"\$NODE" "\$ENTRY" "\$@"$/m)
    const res = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn('bash', [wrapper, 'notification'], { env: { ...process.env, AGENT_INBOX_HOOKS: '0' } })
      let out = ''
      child.stdout.on('data', (d) => { out += String(d) })
      child.on('close', (code) => resolve({ code, out }))
      child.stdin.end('{}')
    })
    expect(res.code).toBe(0)
    expect(res.out).toBe('')
  })
})

describe('hook: the shell wrapper', () => {
  // A throwaway checkout-shaped tree so the wrapper can be driven end to end:
  // its own bytes at hooks/, a dist/hook-cli.js whose exit status we choose, and
  // a HOME with no ~/.local/share/fnm so the v24 glob deterministically misses.
  function tree(cli: string): { script: string; root: string; bin: string } {
    const root = mkdtempSync(join(tmpdir(), 'hook-wrap-'))
    for (const d of ['hooks', 'dist', 'bin']) mkdirSync(join(root, d))
    const script = join(root, 'hooks', 'agent-inbox-hook.sh')
    writeFileSync(script, readFileSync(join(REPO, 'hooks', 'agent-inbox-hook.sh'), 'utf8'))
    writeFileSync(join(root, 'dist', 'hook-cli.js'), cli)
    writeFileSync(join(root, '.node-version'), '24\n')
    return { script, root, bin: join(root, 'bin') }
  }

  function sh(dir: string, name: string, body: string): string {
    const p = join(dir, name)
    writeFileSync(p, `#!/bin/sh\n${body}\n`)
    chmodSync(p, 0o755)
    return p
  }

  function run(script: string, args: string[], env: NodeJS.ProcessEnv): { code: number | null; out: string; err: string } {
    const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', input: '{}', env })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }

  it('refuses a `node` on PATH that has no execute bit, instead of running it', () => {
    const { script, root, bin } = tree('process.exit(7)\n')
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 7\n')
    chmodSync(join(bin, 'node'), 0o644) // the exec bit is the only thing missing

    // The hazard itself, pinned first: bash's `command -v` reports the first
    // PATH entry matching BY NAME and does not check X_OK, so a `-n`-only guard
    // waves this straight through to `"$NODE" "$ENTRY"` → Permission denied, 126.
    const probe = spawnSync('/bin/bash', ['-c', 'command -v node'], { encoding: 'utf8', env: { PATH: bin } })
    expect(probe.stdout.trim()).toBe(join(bin, 'node'))

    const r = run(script, ['prompt-submit'], { HOME: root, PATH: `${bin}:/usr/bin:/bin` })
    expect(r.code).toBe(0)
    expect(r.err).toBe('') // no "Permission denied" in the human's transcript
    expect(r.out).toBe('')
  })

  // Verified against the hooks reference's "Exit code 2 behavior per event"
  // table: 2 is the only status with session-affecting semantics — Stop "blocks,
  // prevents Claude from stopping" (what `watch` is for), UserPromptSubmit
  // "blocks prompt processing and erases the prompt" (what must never happen).
  // Every other non-zero status earns a "<hook name> hook error" transcript
  // notice. So only deliberate statuses are forwarded.
  const POLICY: Array<[string, number, number]> = [
    ['watch', 2, 2],           // #21's async half: swallowing this is a silent no-op
    ['watch', 1, 0],           // a crashed watcher is not a wake-up
    ['watch', 126, 0],
    ['prompt-submit', 2, 0],   // forwarding this would ERASE the human's prompt
    ['stop', 2, 0],            // only watch may block a Stop
    ['stop', 126, 0],          // a broken Node path is not a hook error notice
    ['session-start', 137, 0], // nor is an OOM kill
    ['session-end', 1, 0],
    ['notification', 1, 0],
    ['selftest', 1, 1],        // not a hook event: the installer checks this status
    ['selftest', 0, 0],
  ]
  it.each(POLICY)('%s whose child exits %i makes the wrapper exit %i', (sub, child, want) => {
    const { script, root } = tree(`process.exit(${child})\n`)
    const r = run(script, [sub], { HOME: root, PATH: '/usr/bin:/bin', AGENT_INBOX_NODE: process.execPath })
    expect(r.code).toBe(want)
  })

  it('resolves Node through the fnm invocation that exists — `fnm which` is a dead branch', () => {
    const { script, root, bin } = tree('process.stdout.write("REAL-CLI\\n")\n')
    const pinned = join(root, 'pinned')
    mkdirSync(pinned)
    sh(pinned, 'node', 'echo FNM-PINNED-NODE')
    // stands in for the installed fnm (1.39): `which` is unrecognised, while
    // `exec --using=<v> -- <cmd>` runs <cmd> with that version's bin on PATH
    sh(bin, 'fnm', [
      'if [ "$1" = exec ]; then',
      '  shift',
      '  case "$1" in --using=*) shift ;; esac',
      '  case "$1" in --) shift ;; esac',
      '  PATH="$FNM_PINNED_BIN:$PATH"; export PATH; exec "$@"',
      'fi',
      "echo \"error: unrecognized subcommand '$1'\" >&2",
      'exit 2',
    ].join('\n'))

    const r = run(script, ['stop'], { HOME: root, PATH: `${bin}:/usr/bin:/bin`, FNM_PINNED_BIN: pinned })
    expect(r.code).toBe(0)
    // `fnm which` would have yielded nothing, fallen past the (empty) v24 glob
    // to a `command -v node` that finds no node at all, and printed nothing
    expect(r.out.trim()).toBe('FNM-PINNED-NODE')
  })
})

describe('hook: installer', () => {
  const SCRIPT = join(REPO, 'scripts', 'install-hooks.sh')

  function installer(args: string[], home: string, entry: string, extra: NodeJS.ProcessEnv = {}): { code: number | null; out: string; err: string } {
    const r = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, AGENT_INBOX_HOOK_ENTRY: entry, ...extra },
    })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }

  function home(settings?: unknown): { dir: string; entry: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'hook-home-'))
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const entry = join(dir, 'stub-cli.js')
    writeFileSync(entry, 'process.exit(0)\n') // stands in for a built, verified dist/hook-cli.js
    const file = join(dir, '.claude', 'settings.json')
    if (settings !== undefined) writeFileSync(file, JSON.stringify(settings))
    return { dir, entry, file }
  }

  const withPostToolUse = { model: 'x', hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }

  it('dry-run is the default: it prints a parseable settings block and writes nothing', () => {
    const { dir, entry, file } = home(withPostToolUse)
    const before = readFileSync(file, 'utf8')
    const r = installer([], dir, entry)
    expect(r.code).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(r.err).toMatch(/dry run/i)
    expect(Object.keys(JSON.parse(r.out).hooks).sort()).toEqual(
      ['Notification', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'],
    )
  })

  it('--apply merges alongside a pre-existing hook without dropping it, and backs the file up', () => {
    const { dir, entry, file } = home(withPostToolUse)
    expect(installer(['--apply'], dir, entry).code).toBe(0)
    const s = JSON.parse(readFileSync(file, 'utf8'))
    expect(s.model).toBe('x')
    expect(s.hooks.PostToolUse).toHaveLength(1)
    expect(s.hooks.Notification[0].hooks[0].args).toEqual([entry, 'notification'])
    expect(s.hooks.Notification[0].matcher).toBeUndefined() // no matcher: the env var is the single gate
    expect(s.hooks.SessionStart[0].matcher).toBe('startup|resume')
    expect(s.hooks.Stop[0].hooks.map((h: { args: string[] }) => h.args[1])).toEqual(['stop', 'watch'])
    expect(s.hooks.Stop[0].hooks[1].asyncRewake).toBe(true)
    expect(readdirSync(join(dir, '.claude')).some((f) => f.startsWith('settings.json.bak.'))).toBe(true)
  })

  it('the baked command is an absolute path, never bare node (the Node-26 hazard)', () => {
    const { dir, entry, file } = home({})
    installer(['--apply'], dir, entry)
    const cmd = JSON.parse(readFileSync(file, 'utf8')).hooks.Notification[0].hooks[0].command
    expect(cmd.startsWith('/')).toBe(true)
  })

  // The `not.toContain('fnm_multishells')` assertion used to live in the test
  // above, where it was a tautology: under `fnm exec` (how the suite runs) PATH
  // already points at node-versions/, so it held with stable_path() replaced by
  // `echo "$1"`. Here the ephemeral path is manufactured, so the assertion has
  // something to catch.
  it('normalises an EPHEMERAL fnm_multishells path to the stable installation path', () => {
    const { dir, entry, file } = home({})
    const stableBin = dirname(process.execPath)
    // the real shape: <pid>_<ts>/bin is a symlink into node-versions/, and the
    // whole tree is deleted the moment that shell exits
    const eph = join(dir, '.local', 'state', 'fnm_multishells', '4242_1780000000000')
    mkdirSync(eph, { recursive: true })
    symlinkSync(stableBin, join(eph, 'bin'))
    const ephemeralNode = join(eph, 'bin', 'node')
    expect(existsSync(ephemeralNode)).toBe(true)

    expect(installer(['--apply'], dir, entry, { AGENT_INBOX_NODE: ephemeralNode }).code).toBe(0)
    const cmd = JSON.parse(readFileSync(file, 'utf8')).hooks.Notification[0].hooks[0].command
    expect(cmd).not.toContain('fnm_multishells') // baking this breaks every hook tomorrow
    expect(cmd).toBe(join(realpathSync(stableBin), 'node'))
  })

  it('pins .node-version through the fnm invocation that exists — `fnm which` was a dead branch', () => {
    const { dir, entry, file } = home({})
    const pinned = join(dir, 'pinned')
    mkdirSync(pinned)
    // a real Node under a path of our choosing, so we can tell WHICH branch won
    writeFileSync(join(pinned, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`)
    chmodSync(join(pinned, 'node'), 0o755)
    const fakebin = join(dir, 'fakebin')
    mkdirSync(fakebin)
    writeFileSync(join(fakebin, 'fnm'), ['#!/bin/sh',
      'if [ "$1" = exec ]; then',
      '  shift',
      '  case "$1" in --using=*) shift ;; esac',
      '  case "$1" in --) shift ;; esac',
      '  PATH="$FNM_PINNED_BIN:$PATH"; export PATH; exec "$@"',
      'fi',
      "echo \"error: unrecognized subcommand '$1'\" >&2",
      'exit 2',
    ].join('\n') + '\n')
    chmodSync(join(fakebin, 'fnm'), 0o755)

    // fakebin first so `command -v fnm` finds the stand-in; the rest of PATH
    // stays intact because the installer needs jq
    const r = installer(['--apply'], dir, entry, { PATH: `${fakebin}:${process.env.PATH}`, FNM_PINNED_BIN: pinned })
    expect(r.code).toBe(0)
    const cmd = JSON.parse(readFileSync(file, 'utf8')).hooks.Notification[0].hooks[0].command
    // with `fnm which` the stand-in errors, the branch yields empty and the
    // PATH fallback bakes whatever node happens to be first — not this one
    expect(cmd).toBe(join(realpathSync(pinned), 'node'))
  })

  it('refuses a second install without --force, and does not double up with it', () => {
    const { dir, entry, file } = home({})
    installer(['--apply'], dir, entry)
    const second = installer(['--apply'], dir, entry)
    expect(second.code).not.toBe(0)
    expect(second.err).toMatch(/already installed/)
    expect(installer(['--apply', '--force'], dir, entry).code).toBe(0)
    const s = JSON.parse(readFileSync(file, 'utf8'))
    expect(s.hooks.Notification).toHaveLength(1)
  })

  it('--uninstall removes only the agent-inbox entries', () => {
    const { dir, entry, file } = home(withPostToolUse)
    installer(['--apply'], dir, entry)
    expect(installer(['--apply', '--uninstall'], dir, entry).code).toBe(0)
    const s = JSON.parse(readFileSync(file, 'utf8'))
    expect(s.hooks).toEqual(withPostToolUse.hooks)
    expect(s.model).toBe('x')
  })

  it('--migrate retires the legacy hand-written Stop shell hooks; without it they survive', () => {
    const legacy = {
      hooks: { Stop: [{ hooks: [
        { type: 'command', command: 'bash ~/.claude/hooks/agent-inbox-pending.sh', timeout: 10 },
        { type: 'command', command: 'bash ~/.claude/hooks/agent-inbox-watch.sh', timeout: 1800 },
      ] }] },
    }
    const a = home(legacy)
    installer(['--apply'], a.dir, a.entry)
    expect(JSON.stringify(readFileSync(a.file, 'utf8'))).toContain('agent-inbox-pending.sh')
    const b = home(legacy)
    installer(['--apply', '--migrate'], b.dir, b.entry)
    expect(readFileSync(b.file, 'utf8')).not.toContain('agent-inbox-pending.sh')
    expect(JSON.parse(readFileSync(b.file, 'utf8')).hooks.Stop[0].hooks).toHaveLength(2)
  })

  it('the block it writes is structurally identical to the one the viewer serves', () => {
    // two implementations of one shape (jq in the installer, TS in the viewer);
    // this is what stops them drifting apart
    const { dir, entry } = home({})
    const fromShell = JSON.parse(installer([], dir, entry).out).hooks
    const fromCode = hooksSettingsBlock('NODE', entry).hooks
    const shape = (h: ReturnType<typeof hooksSettingsBlock>['hooks']): unknown =>
      Object.fromEntries(Object.entries(h).map(([k, groups]) => [k, groups.map((g) => ({
        matcher: g.matcher,
        hooks: g.hooks.map((e) => ({ ...e, command: 'NODE' })),
      }))]))
    expect(shape(fromShell)).toEqual(shape(fromCode))
  })

  it('refuses to touch a settings.json that is not valid JSON', () => {
    const { dir, entry, file } = home()
    writeFileSync(file, '{ not json')
    const r = installer(['--apply'], dir, entry)
    expect(r.code).not.toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })

  it('aborts before writing when the resolved Node cannot run selftest', () => {
    const { dir, entry, file } = home({})
    writeFileSync(entry, 'process.exit(1)\n') // stands in for a Node that cannot load better-sqlite3
    const r = installer(['--apply'], dir, entry)
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/selftest.*failed/i)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks).toBeUndefined()
  })
})

describe('hook: docs contract', () => {
  it('docs/hooks.md documents every subcommand the dispatcher answers to', () => {
    const doc = readFileSync(join(REPO, 'docs', 'hooks.md'), 'utf8')
    for (const sub of SUBCOMMANDS) expect(doc).toContain(`\`${sub}\``)
  })

  it('docs/hooks.md documents every env var the runtime reads', () => {
    const doc = readFileSync(join(REPO, 'docs', 'hooks.md'), 'utf8')
    const src = readFileSync(join(REPO, 'src', 'hook.ts'), 'utf8')
    const vars = [...new Set(src.match(/AGENT_INBOX_[A-Z_]+/g) ?? [])]
    expect(vars.length).toBeGreaterThan(5)
    for (const v of vars) expect(doc).toContain(v)
  })

  it('the hook runtime never reaches past store.ts for the database', () => {
    // prose is stripped first: a comment saying "no sqlite3 CLI here" must not
    // read as a violation (the idiom test/dead-exports.test.ts already uses)
    const code = (f: string): string =>
      readFileSync(join(REPO, 'src', f), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
    for (const f of ['hook.ts', 'hook-cli.ts']) {
      expect(code(f)).not.toMatch(/(?<!better-)sqlite3/) // no CLI shell-out, no raw driver
      expect(code(f)).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/)
    }
  })
})
