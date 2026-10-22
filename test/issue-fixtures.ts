// Shared builders for the issue #103 tests (PR1a). Deliberately NOT named
// *.test.ts, so the vitest glob imports it without collecting it.
//
// A snapshot here is exactly the v1 JSON a refresh stores (§4.3). Keys are
// written `owner/name#number`; the builders split them back into parts.
import type {
  IssueDependencies, IssueDependencyList, IssueFacts, IssueRelative, IssueSnapshot, IssueSnapshotRow, IssueError,
} from '../src/store.js'
import type { IssueKeySets } from '../public/issue-key.js'

const HARD = new Set(['not-found', 'forbidden', 'moved'])

/** Minute `m` of one fixed evening, as the canonical ISO text the store keeps. */
export const at = (minute: number): string =>
  new Date(Date.UTC(2026, 9, 19, 22, 0) + minute * 60_000).toISOString()

function parts(key: string): { repo: string; number: number } {
  const hash = key.lastIndexOf('#')
  return { repo: key.slice(0, hash), number: Number(key.slice(hash + 1)) }
}

export function facts(key: string, extra: Partial<IssueRelative> = {}): IssueRelative {
  return { ...parts(key), title: `Title of ${key}`, state: 'OPEN', state_reason: null, ...extra }
}

type Relative = string | IssueRelative

const relative = (r: Relative): IssueRelative => (typeof r === 'string' ? facts(r) : r)

export interface SnapshotOpts {
  issue?: Partial<IssueFacts>
  ancestors?: Relative[]
  end?: 'top' | 'limit'
  children?: Relative[]
  truncated?: boolean
  total?: number
  completed?: number
  unavailable?: boolean
}

export function snapshot(key: string, opts: SnapshotOpts = {}): IssueSnapshot {
  const children = (opts.children ?? []).map(relative)
  const { repo, number, title, state, state_reason } = facts(key, opts.issue)
  return {
    v: 1,
    issue: { repo, number, title, state, state_reason },
    ancestors: (opts.ancestors ?? []).map(relative),
    ancestors_end: opts.end ?? 'top',
    hierarchy: opts.unavailable
      ? { status: 'unavailable' }
      : {
          status: 'ok',
          total: opts.total ?? children.length,
          completed: opts.completed ?? children.filter((c) => c.state === 'CLOSED').length,
          truncated: opts.truncated ?? false,
          children,
        },
  }
}

export interface DepsOpts {
  blockedBy?: Relative[]
  blocking?: Relative[]
  /** GitHub had more, or an entry was dropped: the list is no evidence of absence */
  blockedByTruncated?: boolean
  blockingTruncated?: boolean
  /** issueDependenciesSummary; by default the list's open entries and its length */
  blockedByCounts?: { open: number; total: number }
  blockingCounts?: { open: number; total: number }
}

function dependencyList(entries: Relative[] = [], truncated = false, counts?: { open: number; total: number }): IssueDependencyList {
  const list = entries.map(relative).map(({ repo, number, title, state, state_reason }) => ({ repo, number, title, state, state_reason }))
  return { open: counts?.open ?? list.filter((i) => i.state === 'OPEN').length, total: counts?.total ?? list.length, truncated, list }
}

/** An `ok` dependency section (slice 2 §5.3): "blocked by" and "blocking", complete unless said otherwise. */
export function deps(opts: DepsOpts = {}): IssueDependencies {
  return {
    status: 'ok',
    blocked_by: dependencyList(opts.blockedBy, opts.blockedByTruncated, opts.blockedByCounts),
    blocking: dependencyList(opts.blocking, opts.blockingTruncated, opts.blockingCounts),
  }
}

/**
 * Every key's section from one set of "from blocks to" pairs, both directions
 * agreeing as GitHub keeps them: what a refresh of each key would store.
 */
export function depsOf(pairs: Array<[string, string]>): (key: string) => IssueDependencies {
  return (key) => deps({
    blockedBy: pairs.filter(([, to]) => to === key).map(([from]) => from),
    blocking: pairs.filter(([from]) => from === key).map(([, to]) => to),
  })
}

/**
 * A listIssueSnapshots() row, built without a database for the pure builder.
 * `dependencies` is the section as listIssueSnapshots reads it: bound to this
 * row's fetched_at, or null (missing, unbound or unreadable: "unknown").
 */
export function row(
  key: string,
  snap: IssueSnapshot | null,
  fetchedAt: string | null,
  extra: { error?: IssueError | null; checkedAt?: string; dependencies?: IssueDependencies | null } = {},
): IssueSnapshotRow {
  const error = extra.error ?? null
  return {
    ...parts(key),
    provider: 'github',
    snapshot: snap,
    // only ever read beside a readable snapshot
    dependencies: snap ? extra.dependencies ?? null : null,
    fetched_at: snap ? fetchedAt : null,
    checked_at: extra.checkedAt ?? fetchedAt ?? at(0),
    error,
    failure: error === null ? null : HARD.has(error) ? 'hard' : 'soft',
    revision: 1,
  }
}

/** Display roots for the builder; every one refreshes unless listed in `displayOnly`. */
export function keySets(
  display: string[],
  opts: { displayOnly?: string[]; updatedAt?: Record<string, string> } = {},
): IssueKeySets {
  const only = new Set(opts.displayOnly ?? [])
  const refresh = new Set(display.filter((key) => !only.has(key)))
  return {
    refresh,
    display: new Map(display.map((key) => [key, {
      refresh: refresh.has(key),
      updated_at: opts.updatedAt?.[key] ?? at(0),
    }])),
  }
}
