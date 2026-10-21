// Shared builders for the issue #103 tests (PR1a). Deliberately NOT named
// *.test.ts, so the vitest glob imports it without collecting it.
//
// A snapshot here is exactly the v1 JSON a refresh stores (§4.3). Keys are
// written `owner/name#number`; the builders split them back into parts.
import type {
  IssueFacts, IssueRelative, IssueSnapshot, IssueSnapshotRow, IssueError,
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

/** A listIssueSnapshots() row, built without a database for the pure builder. */
export function row(
  key: string,
  snap: IssueSnapshot | null,
  fetchedAt: string | null,
  extra: { error?: IssueError | null; checkedAt?: string } = {},
): IssueSnapshotRow {
  const error = extra.error ?? null
  return {
    ...parts(key),
    provider: 'github',
    snapshot: snap,
    dependencies: null,
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
