// VIEWER PROCESS ONLY — issue #103's GitHub sub-issue poller (design §5).
//
// Like src/prstate.ts, this shells out to `gh`, so it must never be imported by
// any file of the stdio MCP server's graph: that process speaks MCP over
// stdout, and a subprocess that inherited a stream, or gh's update notifier
// printing one line, would corrupt the protocol wire. `execFile` pipes both
// streams by construction, takes argv only (never a shell) and is bounded by
// GH_TIMEOUT_MS and GH_MAX_BUFFER. test/prstate.test.ts pins the boundary.
//
// The other rules prstate.ts keeps hold here too:
//   · src/store.ts is the only door to SQLite. The queue is a pure function over
//     what the store returned; claims, leases and snapshot writes are store calls.
//   · Nothing here reaches public/attention.js, a badge or a notification: issue
//     relationships are ambient (§9).
//   · Every refresh resolves, never rejects: it runs from a timer inside the
//     process that serves the human's UI.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  claimIssueRefresh, completeIssueRefresh, listIssueEntities, listIssueSnapshots, listSourceLinks,
} from './store.js'
import type {
  IssueClaimKey, IssueEntity, IssueError, IssueRefreshResult, IssueRelative, IssueSnapshot, IssueSnapshotRow, SourceLink,
} from './store.js'
import {
  FIRST_TICK_DELAY_MS, GH_MAX_BUFFER, GH_TIMEOUT_MS, POLL_INTERVAL_MS, classifyError, refreshOnce, resolveGh,
} from './prstate.js'
import type { GhApiRun, GhRun } from './prstate.js'
import { issueKey, issueKeyFor, issueKeySets } from '../public/issue-key.js'

// ── every tunable number, in one place (§5.2–5.5) ───────────────────────────
const MIN = 60_000
/** issues per GraphQL call; one document per size from 1 to this */
export const ISSUE_BATCH = 10
/** the per-viewer token bucket, refilled continuously */
export const ISSUE_POINTS_PER_HOUR = 120
/** below this many GraphQL points remaining, wait for resetAt */
export const RATE_FLOOR = 500
/** a claim outlives GH_TIMEOUT_MS plus parsing and writing */
const LEASE_MS = 60_000
/** after t0 + this, the issue class starts no gh call */
const ISSUE_DEADLINE_MS = 15_000
/** after t0 + this, the PR class starts no new target */
const PR_DEADLINE_MS = 45_000
/** the longest the floor or a rate-limit backoff ever parks the class */
const MAX_WAIT_MS = 60 * MIN
const TITLE_MAX = 300
const ANCESTORS_MAX = 8
const CHILDREN_MAX = 100

/**
 * When a candidate is due again (§5.4). `hard` departs from the design's 60
 * minutes on purpose: a soft failure after a hard one keeps the hard error but
 * moves its time forward (revision 4), and while it does, newer observations
 * of that issue from other roots stay hidden (rule 6). Only the issue's own
 * next SUCCESS ends that, so the retry uses the soft schedule.
 */
export const ISSUE_TTL = {
  open: 10 * MIN,
  closed: 60 * MIN,
  /** offline, rate-limit, gh-failed */
  soft: 10 * MIN,
  /** no-gh, auth: nothing changes in a minute */
  softSlow: 60 * MIN,
  /** not-found, forbidden, moved */
  hard: 10 * MIN,
} as const

const HARD = new Set<string>(['not-found', 'forbidden', 'moved'])

export interface RateLimit {
  cost: number
  remaining: number
  resetAt: string
}

/** What one `gh api graphql` call left behind; a non-zero exit still carries stdout (§2.6). */
export interface IssueGhResult {
  stdout: string
  stderr: string
  code: number | string | null
}

/** Injected so tests never shell out. */
export type IssueGhRun = (args: string[]) => Promise<IssueGhResult> | IssueGhResult

// ── query documents (§5.6) ──────────────────────────────────────────────────

const FRAGMENTS = `fragment Node on Issue { number title state stateReason repository { nameWithOwner } }

fragment Root on Issue {
  ...Node
  subIssuesSummary { total completed }
  parent {
    ...Node
    subIssuesSummary { total completed }
    parent { ...Node parent { ...Node parent { ...Node parent { ...Node
      parent { ...Node parent { ...Node parent { ...Node } } } } } } }
  }
  subIssues(first: 100) { totalCount pageInfo { hasNextPage } nodes { ...Node subIssuesSummary { total completed } } }
}`

// One deterministic document per batch size: GitHub validates every declared
// variable, so a ten-slot document fails for any smaller batch (§2.5). Aliases
// come from indices, never from data.
export function relationsQuery(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > ISSUE_BATCH) throw new Error(`invalid batch size: ${n}`)
  const vars: string[] = []
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    vars.push(`$o${i}: String!, $n${i}: String!, $k${i}: Int!`)
    lines.push(`  r${i}: repository(owner: $o${i}, name: $n${i}) { nameWithOwner issue(number: $k${i}) { ...Root } }`)
  }
  return `query Relations${n}(${vars.join(', ')}) {\n${lines.join('\n')}\n  rateLimit { cost remaining resetAt }\n}\n\n${FRAGMENTS}\n`
}

// Owner and name only as -f raw strings (-F converts types and reads a file for
// a value starting with @); numbers through -F after integer validation.
// --hostname pins github.com so GH_HOST cannot redirect the call.
export function relationsArgs(batch: Array<{ repo: string; number: number }>): string[] {
  const args = ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${relationsQuery(batch.length)}`]
  batch.forEach(({ repo, number }, i) => {
    if (issueKey(repo, number) === null) throw new Error(`invalid issue key: ${repo}#${number}`)
    const [owner, name] = repo.split('/')
    args.push('-f', `o${i}=${owner}`, '-f', `n${i}=${name}`, '-F', `k${i}=${number}`)
  })
  return args
}

// ── parsing and identity checks (§5.7), pure ────────────────────────────────

export type IssueOutcome = { snapshot: IssueSnapshot } | { error: IssueError }

export interface IssueBatch {
  /** one per claimed key, in claimed order */
  outcomes: IssueOutcome[]
  rateLimit: RateLimit | null
  /** set when the whole request failed */
  whole: IssueError | null
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function validSlug(v: unknown): v is string {
  return typeof v === 'string' && issueKey(v, 1) !== null
}

function counts(v: unknown): { total: number; completed: number } | null {
  const s = record(v)
  const total = s?.total
  const completed = s?.completed
  if (typeof total !== 'number' || typeof completed !== 'number') return null
  if (!Number.isInteger(total) || !Number.isInteger(completed) || completed < 0 || completed > total) return null
  return { total, completed }
}

// One `...Node` validated; an invalid one is dropped by the caller, never
// coerced. Counts are optional: invalid ones are left out, the node kept.
function node(v: unknown, withCounts: boolean): IssueRelative | null {
  const n = record(v)
  if (!n) return null
  const repo = record(n.repository)?.nameWithOwner
  if (!validSlug(repo) || issueKey(repo, n.number) === null) return null
  if (typeof n.title !== 'string') return null
  if (n.state !== 'OPEN' && n.state !== 'CLOSED') return null
  const reason = n.stateReason
  if (reason !== null && reason !== 'COMPLETED' && reason !== 'NOT_PLANNED' && reason !== 'DUPLICATE' && reason !== 'REOPENED') return null
  const title = n.title.length > TITLE_MAX ? `${n.title.slice(0, TITLE_MAX)}…` : n.title
  const out: IssueRelative = { repo, number: n.number as number, title, state: n.state, state_reason: reason }
  const c = withCounts ? counts(n.subIssuesSummary) : null
  return c ? { ...out, children_total: c.total, children_completed: c.completed } : out
}

const keyOf = (n: { repo: string; number: number }): string => issueKey(n.repo, n.number)!

// The hierarchy half of a snapshot, or null when it cannot be read: then no
// parentage at all is claimed, so a broken parent is never read as "no parent".
function hierarchy(issue: Record<string, unknown>, root: string): Omit<IssueSnapshot, 'v' | 'issue'> | null {
  const ancestors: IssueRelative[] = []
  let end: 'top' | 'limit' = 'top'
  const seen = new Set([root])
  let next: unknown = issue.parent
  if (next === undefined) return null
  while (next !== null) {
    if (next === undefined || ancestors.length >= ANCESTORS_MAX) {
      // the parent of the last one read was not requested
      end = 'limit'
      break
    }
    const ancestor = node(next, ancestors.length === 0)
    const key = ancestor ? keyOf(ancestor) : null
    if (!ancestor || seen.has(key!)) {
      if (ancestors.length === 0) return null
      end = 'limit'
      break
    }
    seen.add(key!)
    ancestors.push(ancestor)
    next = (next as Record<string, unknown>).parent
  }

  const summary = counts(issue.subIssuesSummary)
  const list = record(issue.subIssues)
  const nodes = list?.nodes
  const more = record(list?.pageInfo)?.hasNextPage
  if (!summary || !Array.isArray(nodes) || typeof more !== 'boolean') return null
  // a list that lost an invalid entry is no longer complete, so it must not
  // count as evidence that any issue left it
  let truncated = more
  const children: IssueRelative[] = []
  const members = new Set<string>()
  for (const raw of nodes as unknown[]) {
    const child = node(raw, true)
    if (!child) {
      truncated = true
      continue
    }
    const key = keyOf(child)
    if (key === root || members.has(key)) continue
    if (children.length >= CHILDREN_MAX) {
      truncated = true
      break
    }
    members.add(key)
    children.push(child)
  }
  return {
    ancestors,
    ancestors_end: end,
    hierarchy: { status: 'ok', total: summary.total, completed: summary.completed, truncated, children },
  }
}

const ERROR_ROOT = (path: unknown[], alias: string): boolean =>
  path[0] === alias && (path.length === 1 || (path.length === 2 && path[1] === 'issue'))

function rootError(errors: Array<{ type: unknown }>): IssueError {
  // data is deleted only on a clear no: any other error on the alias is soft
  if (errors.some((e) => e.type === 'RATE_LIMITED')) return 'rate-limit'
  if (errors.some((e) => e.type !== 'NOT_FOUND' && e.type !== 'FORBIDDEN')) return 'gh-failed'
  return errors.some((e) => e.type === 'FORBIDDEN') ? 'forbidden' : 'not-found'
}

function outcome(
  data: Record<string, unknown>,
  errors: Array<{ type: unknown; path: unknown[] }>,
  i: number,
  requested: { repo: string; number: number },
): IssueOutcome {
  const alias = `r${i}`
  const mine = errors.filter((e) => e.path[0] === alias)
  const atRoot = mine.filter((e) => ERROR_ROOT(e.path, alias))
  if (atRoot.length > 0) return { error: rootError(atRoot) }
  const sectionFailed = mine.some((e) => e.path[1] === 'issue' && (e.path[2] === 'parent' || e.path[2] === 'subIssues'))
  if (mine.some((e) => !(e.path[1] === 'issue' && (e.path[2] === 'parent' || e.path[2] === 'subIssues')))) {
    return { error: 'gh-failed' }
  }

  const repository = record(data[alias])
  const resolved = repository?.nameWithOwner
  const issue = record(repository?.issue)
  if (!validSlug(resolved) || !issue) return { error: 'gh-failed' }
  const own = record(issue.repository)?.nameWithOwner
  if (typeof issue.number !== 'number' || !validSlug(own)) return { error: 'gh-failed' }
  // §4.1: GitHub's repository redirect is an alias; any other mismatch is a
  // transfer or a wrong answer, and transfers are not followed
  if (issue.number !== requested.number || own.toLowerCase() !== resolved.toLowerCase()) return { error: 'moved' }
  const facts = node(issue, false)
  if (!facts) return { error: 'gh-failed' }
  const root = keyOf(facts)
  const rest = sectionFailed ? null : hierarchy(issue, root)
  return {
    snapshot: {
      v: 1,
      issue: { repo: facts.repo, number: facts.number, title: facts.title, state: facts.state, state_reason: facts.state_reason },
      ...(rest ?? { ancestors: [], ancestors_end: 'top', hierarchy: { status: 'unavailable' } }),
    },
  }
}

// Accepts stdout from a success AND from a non-zero exit: a partial batch
// still prints the whole `{ data, errors }` document (§2.6). `failure` is the
// process's exit code and stderr, when it failed.
export function parseIssueBatch(
  stdout: string,
  claimed: Array<{ repo: string; number: number }>,
  failure?: { code: number | string | null; stderr: string },
): IssueBatch {
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = record(JSON.parse(stdout))
  } catch {
    parsed = null
  }
  const errors = (Array.isArray(parsed?.errors) ? parsed.errors as unknown[] : [])
    .map(record).filter((e): e is Record<string, unknown> => e !== null)
    .map((e) => ({ type: e.type, path: Array.isArray(e.path) ? e.path as unknown[] : [] }))
  const data = record(parsed?.data)
  const limit = record(data?.rateLimit)
  const rateLimit = limit && typeof limit.cost === 'number' && Number.isFinite(limit.cost)
    && typeof limit.remaining === 'number' && Number.isFinite(limit.remaining) && typeof limit.resetAt === 'string'
    ? { cost: limit.cost, remaining: limit.remaining, resetAt: limit.resetAt } : null
  if (!data) {
    const whole: IssueError = errors.some((e) => e.type === 'RATE_LIMITED') ? 'rate-limit'
      : failure ? classifyError(failure.code ?? undefined, failure.stderr) as IssueError : 'gh-failed'
    return { outcomes: claimed.map(() => ({ error: whole })), rateLimit, whole }
  }
  return { outcomes: claimed.map((key, i) => outcome(data, errors, i, key)), rateLimit, whole: null }
}

// ── the fair queue (§5.4), pure ─────────────────────────────────────────────

export interface IssueQueueEntry extends IssueClaimKey {
  reason: 'new' | 'nudged' | 'due'
}

function ttlFor(row: IssueSnapshotRow): number {
  if (row.error !== null) {
    if (HARD.has(row.error)) return ISSUE_TTL.hard
    return row.error === 'no-gh' || row.error === 'auth' ? ISSUE_TTL.softSlow : ISSUE_TTL.soft
  }
  return row.snapshot?.issue.state === 'CLOSED' ? ISSUE_TTL.closed : ISSUE_TTL.open
}

const TIER = { new: 0, nudged: 1, due: 2 } as const

// The candidates are the refresh key set (§6), uncapped. Order: never fetched,
// then nudged, then oldest checked_at, then key. Every attempt advances
// checked_at, so a served key moves behind every key that has waited longer.
export function issueQueue(input: {
  entities: IssueEntity[]
  links: SourceLink[]
  snapshots: IssueSnapshotRow[]
  nowMs: number
}): IssueQueueEntry[] {
  const { refresh } = issueKeySets(input.entities, input.links)
  const rows = new Map<string, IssueSnapshotRow>()
  for (const row of input.snapshots) {
    const key = issueKey(row.repo, row.number)
    if (key) rows.set(key, row)
  }
  // A settled PR nudges its CERTAIN closing issue, as of the fetch that saw it
  // settled. A settled PR is re-read hourly, so it nudges at most hourly.
  const settledAt = new Map<string, string>()
  for (const link of input.links) {
    const state = (link.pr_state ?? '').toUpperCase()
    if ((state !== 'MERGED' && state !== 'CLOSED') || !link.fetched_at) continue
    const identity = issueKeyFor(null, link)
    if (!identity || !identity.certain) continue
    const prev = settledAt.get(identity.key)
    if (!prev || link.fetched_at > prev) settledAt.set(identity.key, link.fetched_at)
  }
  const queue: Array<IssueQueueEntry & { key: string }> = []
  for (const key of refresh) {
    const hash = key.lastIndexOf('#')
    const repo = key.slice(0, hash)
    const number = Number(key.slice(hash + 1))
    const row = rows.get(key)
    if (!row) {
      queue.push({ key, repo, number, checked_at: null, reason: 'new' })
      continue
    }
    const listed = row.snapshot?.hierarchy.status === 'ok' ? row.snapshot.hierarchy.children : []
    const nudges = [settledAt.get(key), ...listed.map((c) => settledAt.get(keyOf(c)))]
    if (nudges.some((t) => t !== undefined && t > row.checked_at)) {
      queue.push({ key, repo, number, checked_at: row.checked_at, reason: 'nudged' })
      continue
    }
    const checkedMs = Date.parse(row.checked_at)
    if (Number.isNaN(checkedMs) || input.nowMs - checkedMs >= ttlFor(row)) {
      queue.push({ key, repo, number, checked_at: row.checked_at, reason: 'due' })
    }
  }
  queue.sort((a, b) => TIER[a.reason] - TIER[b.reason]
    || (a.checked_at ?? '').localeCompare(b.checked_at ?? '')
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return queue.map(({ repo, number, checked_at, reason }) => ({ repo, number, checked_at, reason }))
}

// ── the budget (§5.3) ───────────────────────────────────────────────────────

// A token bucket per viewer process, spent by the cost GitHub REPORTS rather
// than an assumed one. `check` says whether a call may start now.
export class IssueBudget {
  private tokens = ISSUE_POINTS_PER_HOUR
  private at: number
  private cost = 1
  private waitUntil = 0

  constructor(nowMs: number) {
    this.at = nowMs
  }

  private refill(nowMs: number): void {
    if (nowMs > this.at) {
      this.tokens = Math.min(ISSUE_POINTS_PER_HOUR, this.tokens + (nowMs - this.at) * ISSUE_POINTS_PER_HOUR / (60 * MIN))
      this.at = nowMs
    }
  }

  /** 'floor': below RATE_FLOOR (or rate-limited) until a reset; 'wait': the bucket is short */
  check(nowMs: number): 'go' | 'wait' | 'floor' {
    this.refill(nowMs)
    if (nowMs < this.waitUntil) return 'floor'
    return this.tokens >= this.cost ? 'go' : 'wait'
  }

  spend(nowMs: number, report: RateLimit | null, rateLimited: boolean): void {
    this.refill(nowMs)
    if (report) this.cost = Math.max(1, report.cost)
    // a call that reports nothing is charged the last reported cost
    this.tokens -= this.cost
    if (report && report.remaining < RATE_FLOOR) {
      const reset = Date.parse(report.resetAt)
      this.waitUntil = Math.min(nowMs + MAX_WAIT_MS, Number.isNaN(reset) ? Infinity : reset)
    } else if (!report && rateLimited) {
      // GitHub asks for a pause before retrying; with no resetAt, back off one soft TTL
      this.waitUntil = Math.max(this.waitUntil, nowMs + ISSUE_TTL.soft)
    }
  }
}

// ── one issue-class run ─────────────────────────────────────────────────────

export interface IssueRefreshOpts {
  run?: IssueGhRun
  now?: () => number
  /** the random id of this viewer process; leases are held in its name */
  owner: string
  budget: IssueBudget
  /** no gh call starts after this time */
  deadlineMs?: number
  /** the keys of snapshots the store refused as invalid and recorded as gh-failed */
  onInvalid?: (keys: string[]) => void
}

export interface IssueRefreshSummary {
  claimed: number
  applied: number
  skipped?: 'deadline' | 'budget' | 'floor' | 'idle'
  failed?: true
}

// Resolves ALWAYS — never rejects. Node 24 defaults to
// --unhandled-rejections=throw, and this runs from a timer in the process that
// serves the human's whole UI (and, under Electron, inside the app itself).
// A key claimed before a failure is released when its 60-second lease expires.
export async function refreshIssuesOnce(db: Database.Database, opts: IssueRefreshOpts): Promise<IssueRefreshSummary> {
  const now = opts.now ?? Date.now
  const run = opts.run ?? defaultIssueGhRun
  try {
    const t = now()
    if (opts.deadlineMs !== undefined && t > opts.deadlineMs) return { claimed: 0, applied: 0, skipped: 'deadline' }
    const verdict = opts.budget.check(t)
    if (verdict === 'wait') return { claimed: 0, applied: 0, skipped: 'budget' }
    const queue = issueQueue({
      entities: listIssueEntities(db), links: listSourceLinks(db), snapshots: listIssueSnapshots(db), nowMs: t,
    })
    if (queue.length === 0) return { claimed: 0, applied: 0, skipped: 'idle' }
    const claimed = claimIssueRefresh(db, { owner: opts.owner, queue, limit: ISSUE_BATCH, leaseMs: LEASE_MS, nowMs: t })
    if (claimed.length === 0) return { claimed: 0, applied: 0, skipped: 'idle' }
    const startedAt = new Date(t).toISOString()
    if (verdict === 'floor') {
      // waiting for resetAt is a soft rate-limit: cached data stays and ages
      const results = claimed.map((k): IssueRefreshResult => ({ repo: k.repo, number: k.number, startedAt, error: 'rate-limit' }))
      return { claimed: claimed.length, applied: completeIssueRefresh(db, { owner: opts.owner, results }), skipped: 'floor' }
    }
    let result: IssueGhResult
    try {
      result = await run(relationsArgs(claimed))
    } catch (err) {
      const e = err as { code?: string | number; stderr?: unknown; message?: unknown }
      result = { stdout: '', stderr: String(e?.stderr ?? e?.message ?? ''), code: e?.code ?? 1 }
    }
    const batch = parseIssueBatch(String(result.stdout ?? ''), claimed,
      result.code === 0 ? undefined : { code: result.code, stderr: String(result.stderr ?? '') })
    opts.budget.spend(now(), batch.rateLimit, batch.whole === 'rate-limit')
    const results = claimed.map((k, i): IssueRefreshResult => ({ repo: k.repo, number: k.number, startedAt, ...batch.outcomes[i]! }))
    const invalid: string[] = []
    const applied = completeIssueRefresh(db, {
      owner: opts.owner, results, onInvalid: (k) => invalid.push(issueKey(k.repo, k.number) ?? `${k.repo}#${k.number}`),
    })
    if (invalid.length) opts.onInvalid?.(invalid)
    return { claimed: claimed.length, applied }
  } catch (err) {
    console.error('[agent-inbox] issue refresh failed', err)
    return { claimed: 0, applied: 0, failed: true }
  }
}

// A snapshot the parser accepted but the store's validator refused is recorded
// as a soft gh-failed (§5.5), which alone looks like an ordinary outage. The
// two disagreeing is a bug worth reporting, so it is said ONCE per poller: one
// stderr line naming keys, never titles. Repeating it each tick would flood
// the log, since the same keys are refetched every 10 minutes.
export function invalidSnapshotNotice(write: (line: string) => void): (keys: string[]) => void {
  let said = false
  return (keys) => {
    if (said || keys.length === 0) return
    said = true
    const shown = keys.slice(0, 5).join(', ') + (keys.length > 5 ? `, and ${keys.length - 5} more` : '')
    write(`[agent-inbox] ${keys.length} GitHub issue snapshot(s) failed validation and were recorded as gh-failed: ${shown}. Later occurrences are not logged.`)
  }
}

// ── the gh subprocess ───────────────────────────────────────────────────────

// Never throws: a non-zero exit is data (a partial batch still prints its JSON).
const defaultIssueGhRun: IssueGhRun = (args) => new Promise((resolve) => {
  execFile(resolveGh(), args, {
    timeout: GH_TIMEOUT_MS,
    maxBuffer: GH_MAX_BUFFER,
    windowsHide: true,
    encoding: 'utf8',
    // quiet gh down: a pager or an update notice on stdout would land in the JSON
    env: { ...process.env, GH_PAGER: 'cat', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  }, (err, stdout, stderr) => {
    if (!err) {
      resolve({ stdout, stderr, code: 0 })
      return
    }
    const e = err as NodeJS.ErrnoException & { code?: string | number }
    resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: e.code ?? 1 })
  })
})

// ── the shared tick (§5.2) ──────────────────────────────────────────────────

export interface GithubPollerOpts {
  run?: GhRun
  runApi?: GhApiRun
  issueRun?: IssueGhRun
  intervalMs?: number
}

// One timer, one busy guard, two classes. The issue class goes first: it is
// one bounded call, so the PR class can no longer push it out of a tick, and
// the PR class still has at least 30 s to start its targets.
export function startGithubPoller(db: Database.Database, opts: GithubPollerOpts = {}): { stop(): void } {
  const owner = randomUUID()
  const budget = new IssueBudget(Date.now())
  // stderr only: under Electron and in the viewer, stdout is no log channel
  const onInvalid = invalidSnapshotNotice((line) => console.error(line))
  let busy = false
  const tick = async (): Promise<void> => {
    if (busy) return // a slow tick must never overlap the next one
    busy = true
    try {
      const t0 = Date.now()
      await refreshIssuesOnce(db, { run: opts.issueRun, owner, budget, deadlineMs: t0 + ISSUE_DEADLINE_MS, onInvalid })
      await refreshOnce(db, { run: opts.run, runApi: opts.runApi, deadlineMs: t0 + PR_DEADLINE_MS })
    } catch (err) {
      console.error('[agent-inbox] github refresh failed', err)
    } finally {
      busy = false
    }
  }
  // .unref() on both: the poller must never be the reason a process stays alive
  const first = setTimeout(() => { void tick() }, FIRST_TICK_DELAY_MS)
  first.unref()
  const timer = setInterval(() => { void tick() }, opts.intervalMs ?? POLL_INTERVAL_MS)
  timer.unref()
  return {
    stop() {
      clearTimeout(first)
      clearInterval(timer)
    },
  }
}
