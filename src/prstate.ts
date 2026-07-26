// VIEWER PROCESS ONLY — issue #30's live PR state.
//
// This is the ONE module in the repo that shells out to a network tool (`gh`).
// It must never be imported by src/mcp.ts or src/mcp-server.ts, directly or
// transitively: that process speaks MCP over stdout, so a subprocess that
// inherited a stream — or gh's update notifier printing one line — would corrupt
// the protocol wire. `execFile` pipes both streams by construction; if this ever
// switches to `spawn` it MUST pass stdio:['ignore','pipe','ignore'] the way
// src/infer.ts's git() does. test/prstate.test.ts pins both halves.
//
// Two more rules this file exists to keep:
//   · src/store.ts is the only door to SQLite. Nothing here writes SQL; the TTL
//     POLICY (dueTargets) is a pure function over what the store already returned.
//   · A red CI is the AGENT's problem, not the human being blocked. Nothing here
//     touches public/attention.js, the tab badge or the dock badge — PR state is
//     ambient only (tenets 1 and 2).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'
import type Database from 'better-sqlite3'
import { listLinkTargets, listSourceLinks, upsertSourceLink, recordLinkFailure } from './store.js'
import type { LinkTarget, SourceLink } from './store.js'

// ── cadence, TTLs and subprocess limits: every tunable number, in one place ──
const MIN = 60_000
/** how often the poller wakes up at all */
export const POLL_INTERVAL_MS = 60_000
/** a prompt first refresh shortly after the viewer boots, without blocking start */
export const FIRST_TICK_DELAY_MS = 2_000
/** ceiling on gh calls per tick — with a handful of live branches this stays far
 *  under 100 calls/hour against a 5000/hour authenticated limit */
export const MAX_PER_TICK = 4
export const GH_TIMEOUT_MS = 10_000
export const GH_MAX_BUFFER = 8 * 1024 * 1024
/** how long a cached answer stays good, by what the answer was */
export const TTL = {
  /** an open PR moves: checks land, reviews arrive */
  openPr: 5 * MIN,
  /** no PR yet — worth re-asking, but not urgently */
  noPr: 15 * MIN,
  /** MERGED or CLOSED is terminal; we only re-ask in case it reopens */
  settled: 60 * MIN,
  /** a transient failure (offline, rate limit, a bad repo) */
  errorSoft: 10 * MIN,
  /** gh is not installed or not authenticated — nothing will change in a minute */
  errorHard: 60 * MIN,
} as const

export type LinkError = 'no-gh' | 'auth' | 'rate-limit' | 'offline' | 'no-pr' | 'gh-failed'
export type ChecksState = 'failing' | 'pending' | 'passing' | 'none'

/** Injected so tests never shell out. Returns gh's raw stdout. */
export type GhRun = (repo: string, branch: string) => Promise<string> | string

export interface PrPayload {
  pr_number: number
  pr_url: string | null
  pr_title: string | null
  pr_state: string | null
  pr_draft: boolean
  review_decision: string | null
  checks: ChecksState
  issue_number: number | null
  issue_url: string | null
  issue_title: string | null
  tldr: string
}

// ── pure classification ─────────────────────────────────────────────────────

const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
const FAILING_STATES = new Set(['FAILURE', 'ERROR'])

// Worst-first: one red check beats a hundred green ones. SKIPPED / NEUTRAL /
// CANCELLED are IGNORED rather than counted as failure — a repo with conditional
// workflows would otherwise read permanently red — so a rollup containing only
// those is 'none', which renders nothing at all.
export function classifyChecks(rollup: unknown): ChecksState {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  let pending = false
  let passing = false
  for (const raw of rollup as unknown[]) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as { status?: unknown; conclusion?: unknown; state?: unknown }
    if (typeof c.state === 'string') {
      const state = c.state.toUpperCase()
      if (FAILING_STATES.has(state)) return 'failing'
      if (state === 'PENDING' || state === 'EXPECTED') pending = true
      else if (state === 'SUCCESS') passing = true
      continue
    }
    const status = typeof c.status === 'string' ? c.status.toUpperCase() : ''
    const conclusion = typeof c.conclusion === 'string' ? c.conclusion.toUpperCase() : ''
    if (FAILING_CONCLUSIONS.has(conclusion)) return 'failing'
    if (status && status !== 'COMPLETED') pending = true
    else if (conclusion === 'SUCCESS') passing = true
  }
  if (pending) return 'pending'
  return passing ? 'passing' : 'none'
}

const TLDR_MAX = 240
const TITLE_MAX = 300

// The TL;DR: the first line of the PR body that says anything, with the most
// common markdown openers peeled off. No model call — this is dumb infra.
export function firstLine(body: unknown): string {
  if (typeof body !== 'string') return ''
  for (const raw of body.split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^[>\s]+/, '')
      .replace(/^#{1,6}\s*/, '')
      // a bullet marker needs the space after it — `**bold**` is emphasis, not a list
      .replace(/^[-*+]\s+/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (line) return line.length > TLDR_MAX ? `${line.slice(0, TLDR_MAX)}…` : line
  }
  return ''
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

function clip(v: unknown, max: number): string | null {
  const s = str(v)
  if (s === null) return null
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// `gh pr list --json …` emits an ARRAY — empty when the branch has no PR, which
// is a real answer rather than a failure. noUncheckedIndexedAccess is why every
// index here is guarded rather than asserted: the array is genuinely empty in
// the ordinary case.
export function parsePrPayload(json: string): PrPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const first = (parsed as unknown[])[0]
  if (!first || typeof first !== 'object') return null
  const pr = first as Record<string, unknown>
  if (typeof pr.number !== 'number') return null
  const closes = Array.isArray(pr.closingIssuesReferences) ? (pr.closingIssuesReferences as unknown[])[0] : undefined
  const issue = closes && typeof closes === 'object' ? (closes as Record<string, unknown>) : undefined
  return {
    pr_number: pr.number,
    pr_url: str(pr.url),
    pr_title: clip(pr.title, TITLE_MAX),
    pr_state: str(pr.state),
    pr_draft: pr.isDraft === true,
    review_decision: str(pr.reviewDecision),
    checks: classifyChecks(pr.statusCheckRollup),
    issue_number: typeof issue?.number === 'number' ? issue.number : null,
    issue_url: str(issue?.url),
    // `gh pr list` does not carry the linked issue's TITLE. The column exists so
    // the frontend has one place to read it from and a later `gh issue view`
    // fill-in needs no migration; v1 leaves it null and renders "#30".
    issue_title: null,
    tldr: firstLine(pr.body),
  }
}

export function classifyError(code: string | number | undefined, stderr: string): LinkError {
  if (code === 'ENOENT') return 'no-gh'
  const s = (stderr || '').toLowerCase()
  if (s.includes('auth') || s.includes('not logged in')) return 'auth'
  if (s.includes('rate limit')) return 'rate-limit'
  if (s.includes('no such host') || s.includes('dial tcp') || s.includes('network is unreachable') || s.includes('connection refused')) {
    return 'offline'
  }
  return 'gh-failed'
}

// ── the TTL policy: which branches are worth a gh call right now ─────────────

function ttlFor(link: SourceLink): number {
  if (link.error === 'no-gh' || link.error === 'auth') return TTL.errorHard
  if (link.error) return TTL.errorSoft
  const state = (link.pr_state ?? '').toUpperCase()
  if (state === 'MERGED' || state === 'CLOSED') return TTL.settled
  if (link.pr_number === null) return TTL.noPr
  return TTL.openPr
}

const keyOf = (repo: string, branch: string): string => `${repo} ${branch}`

// Pure: everything it needs already came out of store.ts. A branch with no cache
// row is due immediately and sorts first, so a newly-flagged item lights up on
// the next tick rather than waiting behind an established branch.
export function dueTargets(targets: LinkTarget[], links: SourceLink[], nowMs: number): LinkTarget[] {
  const byKey = new Map(links.map((l) => [keyOf(l.repo, l.branch), l]))
  const due: Array<{ target: LinkTarget; checkedMs: number }> = []
  for (const t of targets) {
    const link = byKey.get(keyOf(t.repo, t.branch))
    if (!link) {
      due.push({ target: t, checkedMs: -Infinity })
      continue
    }
    const checkedMs = Date.parse(link.checked_at)
    const age = Number.isNaN(checkedMs) ? Infinity : nowMs - checkedMs
    if (age >= ttlFor(link)) due.push({ target: t, checkedMs: Number.isNaN(checkedMs) ? -Infinity : checkedMs })
  }
  due.sort((a, b) => a.checkedMs - b.checkedMs)
  return due.map((d) => d.target)
}

// ── the refresh loop ────────────────────────────────────────────────────────

export interface RefreshOpts {
  run?: GhRun
  nowMs?: number
  max?: number
}

// Resolves ALWAYS — never rejects. Node 24 defaults to
// --unhandled-rejections=throw, and this runs from a timer inside the process
// that serves the human's entire UI (and, under Electron, inside the app itself).
// A background PR-title fetcher must never be able to take the inbox down.
export async function refreshOnce(db: Database.Database, opts: RefreshOpts = {}): Promise<number> {
  const run = opts.run ?? defaultGhRun
  const nowMs = opts.nowMs ?? Date.now()
  const max = opts.max ?? MAX_PER_TICK
  let targets: LinkTarget[]
  try {
    targets = dueTargets(listLinkTargets(db), listSourceLinks(db), nowMs).slice(0, max)
  } catch (err) {
    console.error('[agent-inbox] pr refresh could not read its targets', err)
    return 0
  }
  let done = 0
  for (const t of targets) {
    try {
      const out = await run(t.repo, t.branch)
      const pr = parsePrPayload(String(out))
      // an empty array is a real answer ("this branch has no PR"), cached like
      // any other so the TTL backs off instead of re-asking every minute
      upsertSourceLink(db, { repo: t.repo, branch: t.branch, provider: 'github', ...(pr ?? {}) })
      done++
    } catch (err) {
      const e = err as { code?: string | number; stderr?: unknown; message?: unknown }
      const reason = classifyError(e?.code, String(e?.stderr ?? e?.message ?? ''))
      try {
        recordLinkFailure(db, { repo: t.repo, branch: t.branch, error: reason })
      } catch (writeErr) {
        console.error('[agent-inbox] pr refresh could not record a failure', writeErr)
      }
    }
  }
  return done
}

// ── the gh subprocess ───────────────────────────────────────────────────────

const execFileAsync = promisify(execFile)

const GH_FALLBACKS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']

// A Finder-launched Electron app inherits a minimal PATH and would never find
// Homebrew's gh, so an explicit fallback list matters more than it looks.
export function resolveGh(): string {
  const override = process.env.AGENT_INBOX_GH
  if (override) return override
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'gh'))) return join(dir, 'gh')
  }
  for (const candidate of [...GH_FALLBACKS, join(homedir(), '.local', 'bin', 'gh')]) {
    if (existsSync(candidate)) return candidate
  }
  return 'gh'
}

// -R and --head are what make this independent of the viewer's cwd: the viewer
// runs from the agent-inbox checkout while the branch may belong to any repo.
export const defaultGhRun: GhRun = async (repo, branch) => {
  const { stdout } = await execFileAsync(
    resolveGh(),
    [
      'pr', 'list',
      '-R', repo,
      '--head', branch,
      '--state', 'all',
      '--limit', '1',
      '--json', 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,closingIssuesReferences,body,updatedAt',
    ],
    {
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
      // quiet gh down: a pager or an update notice on stdout would land in the
      // JSON we parse
      env: { ...process.env, GH_PAGER: 'cat', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    },
  )
  return stdout
}

export interface PollerOpts {
  run?: GhRun
  intervalMs?: number
}

export function startPrPoller(db: Database.Database, opts: PollerOpts = {}): { stop(): void } {
  const run = opts.run ?? defaultGhRun
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS
  let busy = false
  const tick = (): void => {
    if (busy) return // a slow tick must never overlap the next one
    busy = true
    refreshOnce(db, { run })
      .catch((err: unknown) => console.error('[agent-inbox] pr refresh failed', err))
      .finally(() => { busy = false })
  }
  // .unref() on both: the poller must never be the reason a process stays alive
  const first = setTimeout(tick, FIRST_TICK_DELAY_MS)
  first.unref()
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return {
    stop() {
      clearTimeout(first)
      clearInterval(timer)
    },
  }
}
